import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { getMimeType } from 'hono/utils/mime';
import { CLAUDE_DEFAULT_TOOLS as DEFAULT_TOOLS, type PermissionAnswer } from '@kelpie/adapters';
import { Harness, type AgentUpdate, type EventData, type KelpieEvent, type Mode } from '@kelpie/protocol';
import type { Store, WorktreeRow } from '@kelpie/store';
import type { RunContext, SentFile, Session, SessionDefaults, SessionHooks, SessionManager } from '../sessions.js';
import { logLines, report, type AgentReport, type LogPage } from './digest.js';
import { GitError, type Branch, type Worktrees } from '../worktrees.js';
import { AGENT_RESTARTED, NOTIFICATION_TAG, ORCHESTRATOR_RESTARTED, agentPrompt, freshPreface, musterPrompt, orchestratorPrompt, type WorkPlace } from './prompt.js';

/**
 * The orchestrator's built-in tools: read-only ones, for its repo checkout, its feature branch's
 * worktree and its scratch folder. No Bash: Claude Code approves some commands itself (read-only
 * ones; filesystem ones like rm in accept-edits) before Kelpie is asked, so it can't be held to
 * read-only git. Its plan is its agents (list_agents); everything else is the kelpie MCP server.
 */
export const ORCHESTRATOR_TOOLS = ['Read', 'Grep', 'Glob'];
/** Tools the orchestrator gets to write in its scratch folder only (a spec to pass on), never in the repo. */
export const SCRATCH_TOOLS = ['Edit', 'Write'];
const FILE_TOOLS = ['Read', 'Edit', 'Write'];
/** A permission rule's pattern for everything under an absolute path (Claude Code writes those with a leading `//`). */
const under = (dir: string) => `/${dir}/**`;
const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
/**
 * A path with links resolved, as far up as it exists (a file still to be written sits in a real
 * directory). Undefined if something on the way is there but won't resolve, like a link to a
 * missing file: writing through it would create its target, wherever that is.
 */
const real = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    if (exists(path)) return undefined;
    const parent = dirname(path);
    if (parent === path) return path;
    const up = real(parent);
    return up === undefined ? undefined : join(up, basename(path));
  }
};
const within = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);
/** A `..` segment: refused, not folded, since the OS follows a link before it goes up while `resolve` folds first. */
const goesUp = (path: string) => path.split(/[\\/]/).includes('..');
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
export const READ_ONLY_TOOLS = DEFAULT_TOOLS.filter((t) => !EDIT_TOOLS.has(t));

const REPORT_CHARS = 2000;

/** A refusal the orchestrator should read and act on (not a Kelpie bug). */
export class ToolError extends Error {}

/** The base branch can't change: writers have already started from it. */
export class BaseFixedError extends ToolError {}

export interface OrchestratorOptions {
  store: Store;
  /** Where harnesses reach the kelpie MCP server, e.g. http://127.0.0.1:7317/mcp. */
  mcpUrl: string;
  /** Sub-agents one orchestrator may have working at once. */
  maxAgents?: number;
  /** Idles within this window go to the orchestrator as one notification. */
  notifyDelayMs?: number;
  /** Git worktrees for writing agents. Without it (or outside a git repo) writers share the round-up's cwd, one at a time. */
  worktrees?: Worktrees;
}

/** The harness mode an agent runs in: plan mode only stops new work that writes, so readers (and work under way) run in auto. */
const agentMode = (mode: Mode) => (mode === 'acceptEdits' ? 'acceptEdits' : 'auto');
const PLANNING =
  'The person has this round-up in plan mode: no agent may change files. Investigate with read-only agents, then write your plan to your plan file and put it to the person with ExitPlanMode; once they approve it, writers can start.';
/** Agents run in auto mode: one in the person's browser could change things on the sites they are signed in to. */
const PLANNING_BROWSER =
  'The person has this round-up in plan mode: no agent may drive their browser, where it could change things on sites they are signed in to. Investigate with read-only agents without browser (WebFetch reads public pages), then put your plan to the person with ExitPlanMode; once they approve it, browser agents can start.';

const NO_BASE =
  'No base branch is set for this round-up. Ask the person which branch to start from (list_branches shows the options), call set_base_branch with their answer, then spawn the writer.';
const MUSTER_BRIEF_CHARS = 1500;

export interface AgentInfo {
  agentId: string;
  title: string;
  harness: string;
  writes: boolean;
  /** Given the Claude in Chrome tools. */
  browser?: boolean;
  /** Muster, or ordinary work. */
  kind: 'worker' | 'muster';
  /** A writer's own branch, and whether its work is still to be mustered, mustered, or standalone. */
  branch?: string;
  deliver?: 'muster' | 'standalone';
  worktree?: WorktreeRow['state'];
  /** `needs approval`: working, but waiting on the person to allow something it asked for. */
  status: 'working' | 'needs approval' | 'idle' | 'waiting';
  lastTurn: string | undefined;
  updatedAt: string;
  costUsd: number;
}

export interface SpawnInput {
  title: string;
  task: string;
  writes: boolean;
  harness?: string | undefined;
  model?: string | undefined;
  /** A writer's: merged into the feature branch by Muster (default), or a branch that stands alone. */
  deliver?: 'muster' | 'standalone' | undefined;
  /** A read-only agent's: look at this agent's worktree instead of the feature branch. */
  in?: string | undefined;
  /** Files from the scratch folder to list in the brief. */
  files?: string[] | undefined;
  /** Give it the Claude in Chrome tools: it drives the person's own, logged-in browser. */
  browser?: boolean | undefined;
}

export interface AgentList {
  /** The branch the round-up started from, and its feature branch (home), once they exist. */
  baseBranch: string | undefined;
  featureBranch: string | undefined;
  /** Where the feature branch is checked out, while it is on disk: the orchestrator may read it. */
  featureCheckout: string | undefined;
  /** The mode the person has the round-up in. */
  mode: Mode;
  agents: AgentInfo[];
}

/**
 * Turns round-ups into orchestrators over sub-agent round-ups. Owns what is not in the
 * database because it can be rebuilt: bearer tokens, debounce timers, and the queue of
 * sub-agents waiting to be resumed after a restart.
 */
export class Orchestrator implements SessionHooks {
  private sessions: SessionManager | undefined;
  private readonly store: Store;
  private readonly mcpUrl: string;
  readonly maxAgents: number;
  private readonly notifyDelayMs: number;
  /** Bearer token → orchestrator round-up id, one per orchestrator process. */
  private readonly tokens = new Map<string, string>();
  private readonly tokenOfRun = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Each orchestrator's notifications go out one at a time, so two never cover the same idle. */
  private readonly flushes = new Map<string, Promise<void>>();
  /** Sub-agents to resume after a restart once the cap or the writer guard lets them. */
  private readonly waiting = new Set<string>();
  /**
   * Sub-agents a tool call has cleared to start but whose turn is not sent yet (sending can
   * wait for a process that is stopping). They count as working, so no second call slips past
   * the cap or the writer guard in that gap.
   */
  private readonly reserved = new Set<string>();
  /**
   * Writers a spawn call has cleared but not made yet, per orchestrator: making a worktree takes
   * a moment, and the cap must count them meanwhile.
   */
  private readonly starting = new Map<string, number>();
  /** Orchestrators with a browser writer cleared but not made yet: it has the browser meanwhile. */
  private readonly startingBrowser = new Set<string>();
  private readonly worktrees: Worktrees | undefined;
  private warnedUnfenced = false;

  constructor(opts: OrchestratorOptions) {
    this.store = opts.store;
    this.worktrees = opts.worktrees;
    // A process left running in a worktree that goes would outlive its directory.
    if (this.worktrees) this.worktrees.beforeRemove = (row) => this.release(row);
    this.mcpUrl = opts.mcpUrl;
    this.maxAgents = opts.maxAgents ?? 4;
    this.notifyDelayMs = opts.notifyDelayMs ?? 1500;
  }

  attach(sessions: SessionManager): void {
    this.sessions = sessions;
  }

  private get manager(): SessionManager {
    if (!this.sessions) throw new Error('orchestrator is not attached to a session manager');
    return this.sessions;
  }

  // ── hooks ────────────────────────────────────────────────────────────

  specFor(session: Session, run: RunContext): Partial<SessionDefaults> {
    const preface = run.fresh && run.hadHistory ? freshPreface(session.role, this.store.firstSent(session.id)?.text) : '';
    const scratch = session.scratch;
    if (session.role === 'agent') {
      const place = this.placeOf(session);
      // Every agent may read the scratch folder (its brief's files are there); writers may leave files in it.
      const scratchRules = scratch ? (session.writes ? FILE_TOOLS : ['Read']).map((t) => `${t}(${under(scratch)})`) : [];
      return {
        tools: session.writes ? DEFAULT_TOOLS : READ_ONLY_TOOLS,
        // No blanket Bash: auto mode's checks or accept-edits' approvals decide what runs.
        permissionMode: agentMode(session.mode),
        allowedTools: scratchRules,
        ...(scratch ? { addDirs: [scratch] } : {}),
        // The person's one browser, shared by every agent given it: only when the orchestrator asked.
        // Its tools are asked about like any other (auto mode's checks, or the person); none is allowed by rule.
        browser: session.browser,
        appendSystemPrompt:
          (session.kind === 'muster' && place ? musterPrompt(place) : agentPrompt(session.writes, place, scratch, session.browser)) + preface,
      };
    }
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(token, session.id);
    this.tokenOfRun.set(run.runId, token);
    const mcp = { mcpServers: { kelpie: { type: 'http', url: this.mcpUrl, headers: { Authorization: `Bearer ${token}` } } } };
    // Deny beats allow, so a scratch folder inside the repo (KELPIE_HOME under it) would be denied
    // along with it: then `decide` alone keeps the orchestrator from editing the repo.
    const cwd = real(session.cwd) ?? session.cwd;
    const fenced = !!scratch && !within(scratch, cwd);
    if (scratch && !fenced && !this.warnedUnfenced) {
      this.warnedUnfenced = true;
      console.warn(`kelpie: the scratch folder ${scratch} is inside ${cwd}; only Kelpie's own checks keep orchestrators from editing that directory. Set KELPIE_HOME outside it.`);
    }
    // Every worktree, the feature branch's included (it may not exist yet), is under Kelpie's root.
    const root = this.worktrees && (real(this.worktrees.root) ?? this.worktrees.root);
    const denied = [...(fenced ? [cwd] : []), ...(root && !(scratch && within(scratch, root)) ? [root] : [])];
    const planning = session.mode === 'plan';
    return {
      // In plan mode it puts its plan to the person with ExitPlanMode, which only works in the harness's own plan mode.
      tools: [...ORCHESTRATOR_TOOLS, ...(scratch ? SCRATCH_TOOLS : []), ...(planning ? ['ExitPlanMode'] : [])],
      // Default mode, never accept-edits: then every edit asks, and `decide` lets through only those
      // in the scratch folder. The round-up's mode is for its agents (and its prompt).
      permissionMode: planning ? 'plan' : 'default',
      // It reads its repo checkout (its cwd) and scratch folder without asking. Reads anywhere else,
      // the feature branch's worktree included, and all edits go to `decide`.
      allowedTools: ['mcp__kelpie', ...(scratch ? [`Read(${under(scratch)})`] : [])],
      ...(scratch ? { addDirs: [scratch] } : {}),
      // A backstop for edit rules in the project's or the person's own settings, which would settle
      // a request before `decide` sees it: never in the repo or in a worktree.
      ...(denied.length && scratch ? { disallowedTools: denied.flatMap((dir) => SCRATCH_TOOLS.map((t) => `${t}(${under(dir)})`)) } : {}),
      mcpConfig: [JSON.stringify(mcp)],
      appendSystemPrompt: orchestratorPrompt(scratch, session.mode) + preface,
    };
  }

  observe(session: Session, _index: number, event: KelpieEvent): void {
    if (event.kind === 'process.exited') {
      const token = this.tokenOfRun.get(event.runId);
      if (token) this.tokens.delete(token);
      this.tokenOfRun.delete(event.runId);
    }
    if (event.kind === 'activity' && !event.data.busy && session.role === 'agent') {
      if (session.parentId) this.schedule(session.parentId);
      // A slot or the repo may have freed up for an agent waiting to resume.
      if (this.waiting.size) this.resumeWaiting();
    }
  }

  /** Before a harness starts: its worktree is on disk, at its one path (a swept one comes back). */
  async prepare(session: Session): Promise<void> {
    const row = this.worktreeAt(session);
    if (!row || !this.worktrees) return;
    // A reader looking at another agent's worktree must not bring back one whose work was mustered:
    // that would cut a fresh, empty branch in its place.
    if (row.kind === 'agent' && row.sessionId !== session.id && row.state === 'mustered') {
      throw new Error(`the worktree "${session.title}" was reading has been mustered into the feature branch; look there instead`);
    }
    await this.worktrees.ensure(row);
  }

  /**
   * The person changed a round-up's mode. Its agents' live processes switch now; the orchestrator,
   * whose prompt says what the mode means, starts afresh (same conversation) once it is idle.
   */
  async modeChanged(session: Session): Promise<void> {
    // Its tools and prompt follow the mode: they change when it next starts. Leaving plan mode, its
    // harness leaves it at once; entering it waits for the restart, which brings ExitPlanMode (until
    // then Kelpie's own refusals keep writers out).
    session.restartWhenIdle();
    if (session.mode !== 'plan') {
      void session.switchMode('default').catch((err) => console.error(`orchestrator ${session.id}: could not switch mode`, err));
    }
    const mode = agentMode(session.mode);
    // Not awaited: a wedged harness must not hold up the person's change. One that misses it keeps
    // its old mode until its next start, which reads the round-up's.
    for (const child of this.manager.children(session.id)) {
      void child.switchMode(mode).then(
        (ok) => ok || !child.working || console.error(`agent ${child.id}: did not switch to ${mode} mode`),
        (err) => console.error(`agent ${child.id}: could not switch mode`, err),
      );
    }
  }

  /**
   * Answers what the orchestrator's harness asks by policy: its kelpie tools, its read tools in its
   * repo checkout, feature branch worktree and scratch folder, and its edit tools in its scratch
   * folder, are always fine; anything else is refused. Its plan goes to the person. An agent's
   * requests all go to the person.
   */
  decide(session: Session, req: EventData<'permission.requested'>): PermissionAnswer | undefined {
    if (session.role !== 'orchestrator') return undefined;
    if (req.tool === 'ExitPlanMode') {
      return session.mode === 'plan' ? undefined : { allow: false, by: 'kelpie', message: 'This round-up is not in plan mode any more: carry on with the work.' };
    }
    if (req.tool.startsWith('mcp__kelpie__')) return { allow: true, by: 'kelpie' };
    const input = (req.input ?? {}) as { file_path?: unknown; path?: unknown; pattern?: unknown };
    const scratch = session.scratch;
    const cwd = real(session.cwd) ?? session.cwd;
    // Where a path really leads: relative ones from its cwd, as the harness takes them.
    const place = (path: unknown) => (typeof path === 'string' && !goesUp(path) ? real(resolve(cwd, path)) : undefined);
    if (ORCHESTRATOR_TOOLS.includes(req.tool)) {
      // Read names a file; Grep and Glob a directory to search, their cwd when they name none.
      const target = place(req.tool === 'Read' ? input.file_path : (input.path ?? cwd));
      // A Glob pattern names files under that directory, so it may not lead anywhere of its own.
      const pattern = input.pattern;
      const contained = req.tool !== 'Glob' || (typeof pattern === 'string' && !isAbsolute(pattern) && !pattern.startsWith('~') && !goesUp(pattern));
      const home = this.store.worktreeOf(session.id)?.path;
      const readable = [cwd, home && real(home), scratch].filter((dir): dir is string => !!dir);
      // Resolved through links, so none can lead out of those directories.
      if (target && contained && readable.some((dir) => within(target, dir))) return { allow: true, by: 'kelpie' };
    }
    if (scratch && SCRATCH_TOOLS.includes(req.tool)) {
      const path = place(input.file_path);
      if (path?.startsWith(scratch + sep)) return { allow: true, by: 'kelpie' };
    }
    return {
      allow: false,
      by: 'kelpie',
      message: scratch
        ? `You may only use your kelpie tools, read the repo and your feature branch, and write inside your scratch folder (${scratch}). Give changes, commands, and anything else to an agent.`
        : 'You may only use your kelpie tools and read the repo and your feature branch. Give changes, commands, and anything else to an agent.',
    };
  }

  /**
   * A round-up (or one agent) is being deleted: its worktrees come off disk, after whatever was
   * left uncommitted is committed; branches with unmerged work stay.
   */
  async removing(session: Session): Promise<void> {
    if (!this.worktrees) return;
    const kept = session.parentId ? [await this.worktrees.removeAgent(session.id)].filter((b) => b !== undefined) : await this.worktrees.removeRoundUp(session.id);
    if (kept.length) console.log(`"${session.title}" deleted; kept branches with unmerged work: ${kept.join(', ')}`);
  }

  /** The orchestrator round-up a bearer token belongs to, while its process runs. */
  authorize(token: string | undefined): Session | undefined {
    const id = token ? this.tokens.get(token) : undefined;
    return id ? this.manager.get(id) : undefined;
  }

  // ── tools ────────────────────────────────────────────────────────────

  async spawn(parent: Session, input: SpawnInput): Promise<{ agentId: string; status: string }> {
    const harness = Harness.safeParse(input.harness ?? 'claude-code');
    if (!harness.success) throw new ToolError(`unknown harness "${input.harness}"; available: ${Harness.options.join(', ')}`);
    if (!input.task.trim()) throw new ToolError('task is empty: give the agent a complete brief');
    if (input.writes && parent.mode === 'plan') throw new ToolError(PLANNING);
    if (input.browser && parent.mode === 'plan') throw new ToolError(PLANNING_BROWSER);
    const files = this.filesFrom(parent, input.files);
    const send = (child: Session) => child.send(input.task, 'orchestrator', files.length ? { attachments: files } : {});
    // One line: it heads notifications and the UI.
    const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Agent';
    const opts = {
      parentId: parent.id,
      role: 'agent' as const,
      writes: input.writes,
      title,
      ...(input.model ? { model: input.model } : {}),
      ...(input.browser ? { browser: true } : {}),
    };
    const repo = this.worktrees ? await this.worktrees.repoOf(parent.cwd) : undefined;
    // After the only await before an agent exists or is counted as starting: no second call slips past.
    this.checkCap(parent);
    if (input.browser) this.checkBrowser(parent);

    // Outside git (or without worktrees), writers share the round-up's directory, one at a time.
    if (!repo || !this.worktrees) {
      if (input.writes) this.checkWriter(parent.cwd);
      const child = this.manager.create(parent.cwd, opts);
      await this.reserving(child, () => send(child));
      return { agentId: child.id, status: 'working' };
    }

    if (!input.writes) {
      // Readers look at the feature branch, or at one agent's worktree.
      const target = input.in ? this.store.worktreeOf(this.child(parent, input.in).id) : this.store.worktreeOf(parent.id);
      if (input.in && !target) throw new ToolError(`agent ${input.in} has no worktree of its own: only writing agents do`);
      if (input.in && target?.state === 'mustered') throw new ToolError(`that agent's work has been mustered into the feature branch: review it there (omit in)`);
      const child = this.manager.create(target?.path ?? parent.cwd, opts);
      await this.reserving(child, () => send(child));
      return { agentId: child.id, status: 'working' };
    }

    if (!parent.baseBranch || !parent.baseCommit) throw new ToolError(NO_BASE);
    const id = randomUUID();
    // Counted from here: creating the worktree takes a moment, and the cap must count this agent meanwhile.
    this.starting.set(parent.id, (this.starting.get(parent.id) ?? 0) + 1);
    if (input.browser) this.startingBrowser.add(parent.id);
    try {
      // Room for the writer's worktree, and for the feature branch's if this is the first writer;
      // never by sweeping the feature branch it is about to be cut from.
      const need = this.store.worktreeOf(parent.id) ? 1 : 2;
      if (!(await this.worktrees.makeRoom((row) => this.inUse(row), need, (row) => row.sessionId === parent.id))) {
        throw new ToolError(
          `All ${this.worktrees.max} worktrees are in use or hold uncommitted work, so no new writing agent can start. End your turn; you will be notified as agents finish.`,
        );
      }
      const home = await this.worktrees.ensureHome({ id: parent.id, title: parent.title, baseBranch: parent.baseBranch, baseCommit: parent.baseCommit }, repo);
      const child = this.manager.create(this.worktrees.agentPath(repo, parent.id, id), { ...opts, id });
      try {
        await this.worktrees.createAgent({ id, title }, home, input.deliver ?? 'muster');
      } catch (err) {
        await this.manager.delete(child.id);
        throw new ToolError(`could not make a worktree for the agent: ${(err as Error).message}`);
      }
      await this.reserving(child, () => send(child));
      return { agentId: child.id, status: 'working' };
    } finally {
      const n = (this.starting.get(parent.id) ?? 1) - 1;
      if (n > 0) this.starting.set(parent.id, n);
      else this.starting.delete(parent.id);
      if (input.browser) this.startingBrowser.delete(parent.id);
    }
  }

  async list(parent: Session): Promise<AgentList> {
    const home = this.store.worktreeOf(parent.id);
    return {
      baseBranch: parent.baseBranch,
      featureBranch: home?.branch,
      featureCheckout: home && (await this.checkout(home)),
      mode: parent.mode,
      agents: this.manager.children(parent.id).map((c) => this.agentInfo(c)),
    };
  }

  /** The branches the person may start this round-up from, and the one chosen, if any. */
  async branches(parent: Session): Promise<{ baseBranch: string | undefined; branches: Branch[] }> {
    const branches = await this.branchesAt(parent.cwd);
    if (!branches) throw new ToolError(`${parent.cwd} is not a git repository: writers share it, and there is no base branch to choose`);
    return { baseBranch: parent.baseBranch, branches };
  }

  /** The branches a round-up in `cwd` could start from; undefined outside a git repo. */
  async branchesAt(cwd: string): Promise<Branch[] | undefined> {
    const repo = this.worktrees ? await this.worktrees.repoOf(cwd) : undefined;
    return repo && this.worktrees ? this.worktrees.branches(repo) : undefined;
  }

  /** Sets the branch the feature starts from (fetched and pinned now). Fixed once a writer has started. */
  async setBase(parent: Session, branch: string): Promise<{ baseBranch: string; baseCommit: string }> {
    const repo = this.worktrees ? await this.worktrees.repoOf(parent.cwd) : undefined;
    if (!repo || !this.worktrees) throw new ToolError(`${parent.cwd} is not a git repository, so there is no base branch to set`);
    const fixed = () =>
      new BaseFixedError(`the base branch is already ${parent.baseBranch} and writers have started from it; it can't change now (start a new round-up for another base)`);
    if (this.store.worktreeOf(parent.id)) throw fixed();
    let commit: string;
    try {
      commit = await this.worktrees.pinBase(repo, branch.trim());
    } catch (err) {
      if (err instanceof GitError) throw new ToolError(err.message);
      throw err;
    }
    // A writer may have started from the old base while the fetch ran: then it stands.
    if (this.store.worktreeOf(parent.id)) throw fixed();
    parent.setBase(branch.trim(), commit);
    return { baseBranch: branch.trim(), baseCommit: commit };
  }

  /**
   * Brings agents' branches into the feature branch, in order. Kelpie merges what git can merge
   * cleanly; at the first conflict, the rest go to a Muster agent with every agent's brief and report.
   */
  async muster(
    parent: Session,
    agentIds: string[],
    notes?: string,
  ): Promise<{ merged: string[]; muster?: { agentId: string; branches: string[]; conflicts: string[] }; waiting?: { branches: string[]; conflicts: string[]; reason: string } }> {
    if (parent.mode === 'plan') throw new ToolError(PLANNING);
    const home = this.store.worktreeOf(parent.id);
    if (!this.worktrees || !home) throw new ToolError('nothing to muster: no writing agent has worked on a branch of its own yet');
    if (this.manager.children(parent.id).some((c) => c.kind === 'muster' && this.isWorking(c))) {
      throw new ToolError('a Muster agent is already working on the feature branch. End your turn; you will be notified when it finishes.');
    }
    const agents = [...new Set(agentIds)].map((id) => this.child(parent, id));
    const rows: { agent: Session; row: WorktreeRow }[] = [];
    for (const agent of agents) {
      const row = this.store.worktreeOf(agent.id);
      if (this.isWorking(agent)) throw new ToolError(`"${agent.title}" is still working; muster it once it is done`);
      if (!row) throw new ToolError(`"${agent.title}" is read-only: it has no branch to muster`);
      if (row.deliver === 'standalone') throw new ToolError(`"${agent.title}" is standalone: its branch ships on its own and is never mustered`);
      // Whatever it left uncommitted is part of its work.
      if (row.state === 'active') await this.worktrees.checkpoint(row, agent.title);
      if ((await this.worktrees.ownCommits(row)) === 0) throw new ToolError(`"${agent.title}" has nothing to muster: no commits on ${row.branch} beyond the feature branch it was cut from`);
      rows.push({ agent, row });
    }
    // Merging changes files under anyone working in the feature branch (readers running tests).
    if (this.inUse(home)) {
      throw new ToolError('agents are working in the feature branch right now (read-only agents or Muster). End your turn; muster once they are done.');
    }
    const live = await this.worktrees.ensure(home);
    const merged: string[] = [];
    for (const [i, { agent, row }] of rows.entries()) {
      const result = await this.worktrees.merge(live, row.branch, `Muster: ${agent.title} (${row.branch})`);
      if (result.ok) {
        await this.worktrees.mustered(row, live);
        agent.summaryChanged();
        merged.push(agent.title);
        continue;
      }
      // The rest need judgement: Muster, in the feature branch's worktree.
      const rest = rows.slice(i);
      try {
        this.checkCap(parent);
        this.checkWriter(live.path);
      } catch (err) {
        // What merged stays merged: say so, and what is left, rather than only refusing.
        if (!(err instanceof ToolError)) throw err;
        return { merged, waiting: { branches: rest.map((r) => r.row.branch), conflicts: result.conflicts, reason: `${err.message} Muster the rest then.` } };
      }
      const muster = this.manager.create(live.path, {
        parentId: parent.id,
        role: 'agent',
        kind: 'muster',
        writes: true,
        title: `Muster: ${rest.map((r) => r.agent.title).join(', ')}`.slice(0, 120),
      });
      await this.reserving(muster, () => muster.send(this.musterBrief(live, rest, result.conflicts, notes), 'orchestrator'));
      return { merged, muster: { agentId: muster.id, branches: rest.map((r) => r.row.branch), conflicts: result.conflicts } };
    }
    return { merged };
  }

  private musterBrief(home: WorktreeRow, rest: { agent: Session; row: WorktreeRow }[], conflicts: string[], notes: string | undefined): string {
    const clip = (t: string) => (t.length > MUSTER_BRIEF_CHARS ? `${t.slice(0, MUSTER_BRIEF_CHARS)}…` : t);
    const parts = rest.map(({ agent, row }, i) => {
      const r = report(agent.events());
      return `## ${i + 1}. ${row.branch}\nAgent: "${agent.title}"\n\n### Its task\n${clip(this.store.firstSent(agent.id)?.text ?? '(unknown)')}\n\n### Its report\n${clip(r.report) || '(no report)'}`;
    });
    return [
      `Merge these branches into the feature branch \`${home.branch}\` (based on \`${home.baseBranch}\`), in this order:`,
      ...rest.map(({ row }, i) => `${i + 1}. ${row.branch}`),
      '',
      `Kelpie's own merge of ${rest[0]!.row.branch} stopped on conflicts in: ${conflicts.join(', ')}.`,
      ...(notes?.trim() ? ['', `Notes from the orchestrator: ${notes.trim()}`] : []),
      '',
      ...parts,
    ].join('\n');
  }

  read(parent: Session, agentId: string, detail: 'report' | 'log' = 'report', after?: number, limit?: number): (AgentInfo & AgentReport) | (AgentInfo & LogPage) {
    const child = this.child(parent, agentId);
    const events = child.events();
    const info = this.agentInfo(child);
    return detail === 'log' ? { ...info, ...logLines(events, after, limit) } : { ...info, ...report(events) };
  }

  async message(parent: Session, agentId: string, text: string, paths?: string[]): Promise<{ status: string }> {
    const child = this.child(parent, agentId);
    if (!text.trim()) throw new ToolError('text is empty');
    const files = this.filesFrom(parent, paths);
    // A writer picked up again would carry on changing files.
    if (child.writes && parent.mode === 'plan') throw new ToolError(PLANNING);
    // So would one in the person's browser.
    if (child.browser && parent.mode === 'plan') throw new ToolError(PLANNING_BROWSER);
    if (!this.isWorking(child)) {
      this.checkCap(parent);
      if (child.writes) this.checkWriter(child.cwd, child.id);
      if (child.browser) this.checkBrowser(parent, child.id);
    }
    // A message picks up an agent still waiting to resume after a restart: no restart turn later.
    this.waiting.delete(child.id);
    child.clearResumePending();
    await this.reserving(child, () => child.send(text, 'orchestrator', files.length ? { attachments: files } : {}));
    return { status: 'working' };
  }

  /** Files the orchestrator hands an agent: only from its scratch folder (uploads, or files it wrote there). */
  private filesFrom(parent: Session, paths: string[] | undefined): SentFile[] {
    if (!paths?.length) return [];
    const scratch = parent.scratch;
    if (!scratch) throw new ToolError('this round-up has no scratch folder, so there are no files to pass on');
    return [...new Set(paths)].map((p) => {
      let path: string;
      try {
        // Resolved, so neither `..` nor a link can reach outside the folder.
        path = realpathSync(resolve(scratch, p));
      } catch {
        throw new ToolError(`no such file: ${p}`);
      }
      if (!path.startsWith(scratch + sep)) throw new ToolError(`${p} is outside your scratch folder (${scratch}); only files there can be passed to agents`);
      const stat = statSync(path);
      if (!stat.isFile()) throw new ToolError(`${p} is not a file`);
      const mime = getMimeType(path);
      return { name: basename(path), size: stat.size, path, ...(mime ? { mime } : {}) };
    });
  }

  async interrupt(parent: Session, agentId: string): Promise<{ status: string }> {
    const child = this.child(parent, agentId);
    await child.interrupt();
    return { status: child.working ? 'working' : 'idle' };
  }

  // ── recovery ─────────────────────────────────────────────────────────

  /**
   * After a daemon start: resumes every round-up that was working when Kelpie stopped
   * (sub-agents first, as the cap and writer guard allow), and sends each orchestrator the
   * notifications it was still owed.
   */
  async recover(): Promise<void> {
    // Also anything with turns it never took in (e.g. killed in the instant after a send).
    const pending = this.manager.all().filter((s) => s.resumePending || this.store.undelivered(s.id).length > 0);
    for (const agent of pending.filter((s) => s.role === 'agent')) this.waiting.add(agent.id);
    await this.resumeWaiting();
    await Promise.all(pending.filter((s) => s.role === 'orchestrator').map((s) => s.resumeAfterRestart(ORCHESTRATOR_RESTARTED)));
    const parents = new Set(this.manager.all().flatMap((s) => (s.parentId ? [s.parentId] : [])));
    for (const id of parents) this.schedule(id);
  }

  private async resumeWaiting(): Promise<void> {
    for (const id of [...this.waiting]) {
      const agent = this.manager.get(id);
      const parent = agent?.parentId ? this.manager.get(agent.parentId) : undefined;
      if (!agent || !parent) {
        this.waiting.delete(id);
        continue;
      }
      if (this.working(parent) >= this.maxAgents) continue;
      if (agent.writes && this.busyWriter(agent.cwd, agent.id)) continue;
      if (agent.browser && this.browserInUse(parent, agent.id)) continue;
      this.waiting.delete(id);
      try {
        await agent.resumeAfterRestart(AGENT_RESTARTED);
      } catch (err) {
        console.error(`agent ${id}: could not resume`, err);
      }
    }
  }

  // ── notifications ────────────────────────────────────────────────────

  private schedule(parentId: string): void {
    if (this.timers.has(parentId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(parentId);
      const next = (this.flushes.get(parentId) ?? Promise.resolve())
        .then(() => this.flush(parentId))
        // Refused while Kelpie shuts down: the next start sends it (it goes by notifiedIdx).
        .catch((err) => console.error(`orchestrator ${parentId}: notification not sent:`, (err as Error).message));
      this.flushes.set(parentId, next);
      void next.finally(() => this.flushes.get(parentId) === next && this.flushes.delete(parentId));
    }, this.notifyDelayMs);
    timer.unref();
    this.timers.set(parentId, timer);
  }

  /** Tells the orchestrator about every sub-agent that went idle since it was last told. */
  private async flush(parentId: string): Promise<void> {
    const parent = this.manager.get(parentId);
    if (!parent) return;
    const owed = this.manager.children(parentId).flatMap((c) => {
      if (this.isWorking(c) || this.waiting.has(c.id)) return [];
      const idle = this.store.lastEventAt(c.id, 'activity');
      return idle && !idle.event.data.busy && idle.index > c.notifiedIdx ? [{ agent: c, index: idle.index }] : [];
    });
    if (!owed.length) return;
    const home = this.store.worktreeOf(parentId);
    const agents: (AgentUpdate & { report: string })[] = [];
    for (const { agent } of owed) {
      const r = report(agent.events());
      agents.push({
        agentId: agent.id,
        title: agent.title,
        status: r.lastTurn ?? 'not started',
        report: r.report,
        ...(r.error ? { error: r.error } : {}),
        ...(r.filesChanged.length ? { filesChanged: r.filesChanged } : {}),
        ...(await this.branchOf(agent, home)),
      });
    }
    // Muster's outcome is what git says is in the feature branch, not what its report claims.
    const mustered = owed.some(({ agent }) => agent.kind === 'muster') ? await this.settleMuster(parentId) : undefined;
    // Sent and marked in one transaction: after a crash it is neither lost nor sent twice.
    await parent.send(notification(agents, mustered), 'kelpie', {
      alsoInTx: () => owed.forEach(({ agent, index }) => agent.markNotified(index)),
      // The text has each report already, unless it was cut there.
      meta: { agents: agents.map(({ report, ...a }) => (report.length > REPORT_CHARS ? { ...a, report } : a)) },
    });
  }

  /**
   * A writer's branch for its notification: anything it left uncommitted is committed first, so
   * what the orchestrator reads (and later musters) is all of its work.
   */
  private async branchOf(agent: Session, home: WorktreeRow | undefined): Promise<Partial<AgentUpdate>> {
    const row = this.store.worktreeOf(agent.id);
    if (!row || !home || !this.worktrees || row.state !== 'active') return {};
    try {
      await this.worktrees.checkpoint(row, agent.title);
      const stats = await this.worktrees.stats(row, home.branch);
      return { branch: row.branch, ahead: stats.ahead, ...(stats.diffstat ? { diffstat: stats.diffstat } : {}), ...(row.deliver ? { deliver: row.deliver } : {}) };
    } catch (err) {
      console.error(`agent ${agent.id}: could not read its branch`, err);
      return { branch: row.branch };
    }
  }

  /** Marks every agent whose work is now in the feature branch as mustered (its worktree and branch go). */
  private async settleMuster(parentId: string): Promise<{ merged: string[]; pending: string[] }> {
    const home = this.store.worktreeOf(parentId);
    const out = { merged: [] as string[], pending: [] as string[] };
    if (!home || !this.worktrees) return out;
    for (const row of this.store.worktreesOf(parentId)) {
      if (row.kind !== 'agent' || row.deliver !== 'muster' || row.state === 'mustered') continue;
      const agent = this.manager.get(row.sessionId);
      if (!agent || this.isWorking(agent)) continue;
      if (await this.worktrees.musteredIn(row, home)) {
        await this.worktrees.mustered(row, home);
        agent.summaryChanged();
        out.merged.push(agent.title);
      } else if ((await this.worktrees.ownCommits(row)) > 0) out.pending.push(agent.title);
    }
    return out;
  }

  // ── worktree upkeep ──────────────────────────────────────────────────

  /** Removes worktrees left idle (and clean) for a while. Run hourly. */
  async sweep(): Promise<number> {
    return this.worktrees ? this.worktrees.sweep((row) => this.inUse(row)) : 0;
  }

  /**
   * After a daemon start, before recovery: the disk matches the database again. A merge left
   * half-done in a feature branch stays only if its Muster agent is about to resume it.
   */
  async reconcile(): Promise<void> {
    if (!this.worktrees) return;
    await this.worktrees.reconcile((row) => this.manager.children(row.roundUpId).some((c) => c.kind === 'muster' && c.cwd === row.path && c.resumePending));
  }

  /** Ends the idle harness processes running in a worktree about to be removed. */
  private async release(row: WorktreeRow): Promise<void> {
    if (!this.sessions) return;
    await Promise.all(this.manager.all().filter((s) => s.cwd === row.path && !this.isWorking(s)).map((s) => s.stop()));
  }

  /**
   * The feature branch's worktree for the orchestrator to read, brought back if the sweep took it
   * (its reads don't count as use). Undefined if it can't be: it has no other way to make one.
   */
  private async checkout(home: WorktreeRow): Promise<string | undefined> {
    if (!this.worktrees) return existsSync(home.path) ? home.path : undefined;
    try {
      return (await this.worktrees.ensure(home)).path;
    } catch (err) {
      console.error(`could not bring back the feature branch's worktree ${home.path}`, err);
      return undefined;
    }
  }

  /** Someone is working in this worktree right now, or about to (its writer, Muster, or a reader). */
  private inUse(row: WorktreeRow): boolean {
    return this.manager.all().some((s) => s.cwd === row.path && (this.isWorking(s) || s.launching));
  }

  /** The worktree a session runs in: its own, or one it was sent to read (or Muster's feature branch). */
  private worktreeAt(session: Session): WorktreeRow | undefined {
    const own = this.store.worktreeOf(session.id);
    if (own && own.path === session.cwd) return own;
    const roundUp = session.parentId ?? session.id;
    return this.store.worktreesOf(roundUp).find((r) => r.path === session.cwd);
  }

  private placeOf(session: Session): WorkPlace | undefined {
    const row = this.worktreeAt(session);
    return row && { branch: row.branch, parentBranch: row.parentBranch, baseBranch: row.baseBranch, baseCommit: row.baseCommit, own: row.sessionId === session.id };
  }

  // ── rules ────────────────────────────────────────────────────────────

  private isWorking(s: Session): boolean {
    return s.working || this.reserved.has(s.id);
  }

  private working(parent: Session): number {
    return this.manager.children(parent.id).filter((c) => this.isWorking(c)).length;
  }

  private async reserving(child: Session, send: () => Promise<void>): Promise<void> {
    this.reserved.add(child.id);
    try {
      await send();
    } finally {
      this.reserved.delete(child.id);
    }
  }

  private checkCap(parent: Session): void {
    if (this.working(parent) + (this.starting.get(parent.id) ?? 0) >= this.maxAgents) {
      throw new ToolError(
        `${this.maxAgents} agents are already working, the most allowed at once. End your turn; you will be notified as they finish.`,
      );
    }
  }

  private busyWriter(cwd: string, except?: string): Session | undefined {
    return this.manager.all().find((s) => s.role === 'agent' && s.writes && s.cwd === cwd && s.id !== except && this.isWorking(s));
  }

  private checkWriter(cwd: string, except?: string): void {
    const writer = this.busyWriter(cwd, except);
    if (writer) {
      throw new ToolError(
        `writing agent "${writer.title}" is still working in this repo, and only one writer may work at a time. Read-only agents can still run. End your turn; you will be notified when it finishes.`,
      );
    }
  }

  /** What has the person's browser in this round-up, besides `except`: one agent drives it at a time. */
  private browserInUse(parent: Session, except?: string): string | undefined {
    if (this.startingBrowser.has(parent.id)) return 'another browser agent is starting';
    const agent = this.manager.children(parent.id).find((c) => c.browser && c.id !== except && this.isWorking(c));
    return agent && `browser agent "${agent.title}" is still working`;
  }

  private checkBrowser(parent: Session, except?: string): void {
    const busy = this.browserInUse(parent, except);
    if (busy) {
      throw new ToolError(
        `${busy}, and only one agent may drive the person's browser at a time. Agents without browser can still run. End your turn; you will be notified when it finishes.`,
      );
    }
  }

  private child(parent: Session, agentId: string): Session {
    const child = this.manager.get(agentId);
    if (!child || child.parentId !== parent.id) throw new ToolError(`no such agent: ${agentId}`);
    return child;
  }

  private agentInfo(c: Session): AgentInfo {
    const info = c.info();
    const row = this.store.worktreeOf(c.id);
    return {
      agentId: c.id,
      title: c.title,
      harness: info.harness,
      writes: c.writes,
      ...(c.browser ? { browser: true } : {}),
      kind: c.kind,
      ...(row ? { branch: row.branch, worktree: row.state, ...(row.deliver ? { deliver: row.deliver } : {}) } : {}),
      status: this.isWorking(c) ? (c.approvals().length ? 'needs approval' : 'working') : this.waiting.has(c.id) ? 'waiting' : 'idle',
      lastTurn: c.lastTurn,
      updatedAt: new Date(info.updatedAt).toISOString(),
      costUsd: Math.round(this.store.costOf(c.id) * 10_000) / 10_000,
    };
  }
}

/** What the orchestrator reads; the UI renders the same agents from the echo's `agents` and this text. */
function notification(agents: (AgentUpdate & { report: string })[], mustered?: { merged: string[]; pending: string[] }): string {
  const body = agents.map((a) => {
    const text = a.report.length > REPORT_CHARS ? `${a.report.slice(0, REPORT_CHARS)}…\n(report cut; read_agent has all of it)` : a.report;
    const files = a.filesChanged ? `\nFiles changed: ${a.filesChanged.map((f) => `${f.path} (+${f.added} -${f.removed})`).join(', ')}` : '';
    const error = a.error ? `\nError: ${a.error}` : '';
    const branch = a.branch
      ? `\nBranch: ${a.branch} (${a.ahead ?? 0} commit${a.ahead === 1 ? '' : 's'} ahead of the feature branch${a.diffstat ? `; ${a.diffstat}` : ''}; ${a.deliver === 'standalone' ? 'standalone' : 'to muster'})`
      : '';
    return `## Agent "${a.title}" (${a.agentId}) is idle: turn ${a.status}${error}${files}${branch}\n\n${text || '(no report)'}`;
  });
  const settled = mustered
    ? `\n\nIn the feature branch now (checked with git): ${mustered.merged.join(', ') || 'nothing new'}.${mustered.pending.length ? ` Still not mustered: ${mustered.pending.join(', ')}.` : ''}`
    : '';
  return `<${NOTIFICATION_TAG}>\n${body.join('\n\n')}${settled}\n\nThis message is from Kelpie, not the person. Use read_agent for more detail.\n</${NOTIFICATION_TAG}>`;
}
