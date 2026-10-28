import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { getMimeType } from 'hono/utils/mime';
import { ARTIFACT_TOOLS, ARTIFACT_WRITE_RULES, CLAUDE_DEFAULT_TOOLS as DEFAULT_TOOLS, type PermissionAnswer } from '@kelpie/adapters';
import { AGENT_HALT_RESUMED, Harness, haltNote, haltResumed, hasHaltNote, parseTicketUrl, type Settings, type AgentUpdate, type Effort, type LinkedTicket, type EventData, type KelpieEvent, type Mode } from '@kelpie/protocol';
import type { Store, WorktreeRow } from '@kelpie/store';
import type { Connections } from '../connectors/connector.js';
import type { RunContext, SentFile, Session, SessionDefaults, SessionHooks, SessionManager } from '../sessions.js';
import { logLines, report, type AgentReport, type LogPage } from './digest.js';
import { ToolError } from '../errors.js';
import { GitError, operationIn, type Branch, type Worktrees } from '../worktrees.js';
import { Changes } from '../review/changes.js';
import { Reviews, type ReviewClaim } from '../review/reviews.js';
import { SavedSettings } from '../settings.js';
import { askRule, mcpToolPrefix, type McpServers } from '../mcp-servers.js';
import { Workbench } from '../workbench.js';
import { Artifacts } from '../artifacts.js';
import { AGENT_RESTARTED, NOTIFICATION_TAG, ORCHESTRATOR_RESTARTED, agentPrompt, freshPreface, limitResumed, musterPrompt, orchestratorPrompt, reviewBrief, type WorkPlace } from './prompt.js';
import { LIMIT_RESUMED } from '../usage-limits.js';

/**
 * The orchestrator's built-in tools: read-only ones, for its repo checkout, its feature branch's
 * worktree and its scratch folder. No Bash: Claude Code approves some commands itself (read-only
 * ones; filesystem ones like rm in accept-edits) before Kelpie is asked, so it can't be held to
 * read-only git. Its plan is its agents (list_agents); everything else is the kelpie MCP server.
 */
export const ORCHESTRATOR_TOOLS = ['Read', 'Grep', 'Glob'];
/** Tools the orchestrator gets to write in its scratch folder only (a spec to pass on), never in the repo. */
export const SCRATCH_TOOLS = ['Edit', 'Write'];
/** How the orchestrator asks the person something only they can settle: Kelpie puts the questions to them. */
export const ASK_TOOL = 'AskUserQuestion';
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

export { ToolError };

/** The links of tickets still without a title, when there are any (for list_agents). */
const untitled = (tickets: LinkedTicket[]) => {
  const urls = tickets.filter((t) => !t.title).map((t) => t.url);
  return urls.length ? { untitledTickets: urls } : {};
};

/** The base branch can't change: writers have already started from it. */
export class BaseFixedError extends ToolError {}

export interface OrchestratorOptions {
  store: Store;
  /** Where harnesses reach the kelpie MCP server, e.g. http://127.0.0.1:7317/mcp. */
  mcpUrl: string;
  /** Sub-agents one orchestrator may have working at once, until the person sets it in Settings. */
  maxAgents?: number;
  /** The person's settings (the agent limit among them). Default: read from `store`, over `maxAgents`. */
  settings?: SavedSettings;
  /** Idles within this window go to the orchestrator as one notification. */
  notifyDelayMs?: number;
  /** Git worktrees for writing agents. Without it (or outside a git repo) writers share the round-up's cwd, one at a time. */
  worktrees?: Worktrees;
  /** Connected services (GitHub): every harness Kelpie starts gets their env, e.g. GH_TOKEN. */
  connections?: Pick<Connections, 'env'>;
  /** The person's own MCP servers: those they allow go to agents while the setting is on (never to the orchestrator). */
  mcpServers?: Pick<McpServers, 'ensure' | 'forAgents' | 'warnOnce'>;
}

/** The harness mode an agent runs in: plan mode only stops new work that writes, so readers (and work under way) run in auto. */
const agentMode = (mode: Mode) => (mode === 'acceptEdits' ? 'acceptEdits' : 'auto');
const PLANNING =
  'The person has this round-up in plan mode: no agent may change files. Investigate with read-only agents, then write your plan to your plan file and put it to the person with ExitPlanMode; once they approve it, writers can start.';
/** Agents run in auto mode: one in the person's browser could change things on the sites they are signed in to. */
const PLANNING_BROWSER =
  'The person has this round-up in plan mode: no agent may drive their browser, where it could change things on sites they are signed in to. Investigate with read-only agents without browser (WebFetch reads public pages), then put your plan to the person with ExitPlanMode; once they approve it, browser agents can start.';

/** spawn_agent's, message_agent's and muster_agents' refusal while the person has the round-up stopped. */
export const HALTED =
  'The person stopped all agents in this round-up, so no agent may start or be messaged until they resume them in Kelpie. Do not retry or work around it: tell the person, if they asked for something that needs an agent, that it waits until they resume.';

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
  /** Its reasoning effort, if not the harness's default. */
  effort?: Effort;
  /** Muster, or ordinary work. */
  kind: 'worker' | 'muster';
  /** A writer's own branch, and whether its work is still to be mustered, mustered, or standalone. */
  branch?: string;
  deliver?: 'muster' | 'standalone';
  worktree?: WorktreeRow['state'];
  /**
   * `needs approval`: working, but waiting on the person to allow something it asked for. `paused`:
   * stopped at the usage limit until it resets. `stopped by the person`: until they resume it.
   */
  status: 'working' | 'needs approval' | 'idle' | 'waiting' | 'paused' | 'stopped by the person';
  /** While paused: when Kelpie resumes it (ISO), if it will on its own. */
  resumesAt?: string;
  lastTurn: string | undefined;
  updatedAt: string;
  costUsd: number;
}

export interface SpawnInput {
  title: string;
  task: string;
  writes: boolean;
  harness?: string | undefined;
  /** Its model; the round-up's without it. */
  model?: string | undefined;
  /** Its reasoning effort; the round-up's without it. */
  effort?: Effort | undefined;
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
  /** The model and reasoning effort the person picked for the round-up, which agents start with; absent for the harness's default. */
  model?: string;
  effort?: Effort;
  /** How many of its agents may work at once (the person sets it in Settings), and how many count against that now (working, or starting). */
  maxAgents: number;
  working: number;
  agents: AgentInfo[];
  /** Links of the round-up's tickets that have no title yet, for link_ticket to name once it knows them. */
  untitledTickets?: string[];
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
  readonly settings: SavedSettings;
  private readonly notifyDelayMs: number;
  /** Bearer token → orchestrator round-up id, one per orchestrator process. */
  private readonly tokens = new Map<string, string>();
  private readonly tokenOfRun = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Each orchestrator's notifications go out one at a time, so two never cover the same idle. */
  private readonly flushes = new Map<string, Promise<void>>();
  /** Orchestrators refused for the cap since they were last notified: told when the person raises it. */
  private readonly capped = new Set<string>();
  /** The last pass resuming waiting agents, and the one queued after it, if any (see `resumeWaiting`). */
  private resumes: Promise<void> = Promise.resolve();
  private resumeQueued: Promise<void> | undefined;
  /** Sub-agents to resume (after a restart, the usage limit, or the person's "Resume all") once the cap or the writer guard lets them. */
  private readonly waiting = new Map<string, 'restart' | 'limit' | 'halt'>();
  /** Round-ups the person stopped whose orchestrator has not been told yet: it is, with its next turn (see `notice`). */
  private readonly untold = new Set<string>();
  /**
   * What an orchestrator paused at the usage limit is to hear of the person resuming its round-up: it
   * goes with the turn that picks it up after the reset, rather than one the limit would refuse.
   */
  private readonly resumedNotes = new Map<string, string>();
  /** Each round-up's Stop all and Resume all, one at a time: the last one still going. */
  private readonly haltOps = new Map<string, Promise<unknown>>();
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
  private readonly connections: Pick<Connections, 'env'> | undefined;
  private readonly mcpServers: Pick<McpServers, 'ensure' | 'forAgents' | 'warnOnce'> | undefined;
  /** Each session's connection env, read by `prepare` (it can wait) for the `specFor` right after it. */
  private readonly envs = new Map<string, Record<string, string>>();
  private warnedUnfenced = false;
  /** What changed in each round-up (diffs), and the person's reviews of it. */
  readonly changes: Changes;
  readonly reviews: Reviews;
  /** The person's board of features, and where agents say what they are on and leave each other notes. */
  readonly workbench: Workbench;
  /** What the round-up's agents produced for the person: the documents in its scratch folder, and the person's Accepts. */
  readonly artifacts: Artifacts;

  constructor(opts: OrchestratorOptions) {
    this.store = opts.store;
    this.worktrees = opts.worktrees;
    this.connections = opts.connections;
    this.mcpServers = opts.mcpServers;
    // A process left running in a worktree that goes would outlive its directory.
    if (this.worktrees) this.worktrees.beforeRemove = (row) => this.release(row);
    this.mcpUrl = opts.mcpUrl;
    this.settings = opts.settings ?? new SavedSettings(this.store, { maxAgents: opts.maxAgents });
    this.settings.onChange((next, prev) => {
      this.sessions?.publish({ type: 'settings', settings: next });
      if (next.maxAgents > prev.maxAgents) this.limitRaised();
      if (next.autoResume !== prev.autoResume) this.sessions?.limits.settingChanged();
      this.mcpGrantsChanged(next, prev);
    });
    this.notifyDelayMs = opts.notifyDelayMs ?? 1500;
    this.changes = new Changes(this.store);
    this.reviews = new Reviews(this.store, this.changes, {
      publish: (u) => this.sessions?.publish(u),
      session: (id) => this.sessions?.get(id),
      claim: (parent, agentId) => this.claimForReview(parent, agentId),
    });
    this.workbench = new Workbench(this.store, this.worktrees);
    this.artifacts = new Artifacts(this.store);
  }

  attach(sessions: SessionManager): void {
    this.sessions = sessions;
    this.workbench.attach(sessions);
  }

  /** How many of a round-up's agents may work at once: the person's setting, read afresh each time. */
  get maxAgents(): number {
    return this.settings.get().maxAgents;
  }

  private get manager(): SessionManager {
    if (!this.sessions) throw new Error('orchestrator is not attached to a session manager');
    return this.sessions;
  }

  // ── hooks ────────────────────────────────────────────────────────────

  specFor(session: Session, run: RunContext): Partial<SessionDefaults> {
    const preface = run.fresh && run.hadHistory ? freshPreface(session.role, this.store.firstSent(session.id)?.text) : '';
    const scratch = session.scratch;
    // Every process gets its own token for the kelpie MCP server, revoked when it exits: it says who is calling.
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(token, session.id);
    this.tokenOfRun.set(run.runId, token);
    const mcpConfig = [JSON.stringify({ mcpServers: { kelpie: { type: 'http', url: this.mcpUrl, headers: { Authorization: `Bearer ${token}` } } } })];
    const env = this.envs.get(session.id);
    this.envs.delete(session.id);
    const connected = env && Object.keys(env).length ? { env } : {};
    if (session.role === 'agent') {
      const place = this.placeOf(session);
      // Every agent may read the scratch folder (its brief's files are there); writers may leave files in it.
      const scratchRules = scratch ? (session.writes ? FILE_TOOLS : ['Read']).map((t) => `${t}(${under(scratch)})`) : [];
      const own = this.personsServers(session);
      // A claude.ai connector allowed lets agents act with the person's claude.ai login: Claude Code's
      // own artifact tools come with it, asked about like the connector's.
      const artifacts = !!own && Object.values(own.servers).some((c) => c.type === 'claudeai-proxy');
      const tools = session.writes ? DEFAULT_TOOLS : READ_ONLY_TOOLS;
      // A reader is denied their tools that change things: those not marked read-only, and the artifact tools' writing actions.
      const denied = own && !session.writes ? [...own.writes, ...(artifacts ? ARTIFACT_WRITE_RULES : [])] : [];
      return {
        tools: artifacts ? [...tools, ...ARTIFACT_TOOLS] : tools,
        // No blanket Bash: auto mode's checks or accept-edits' approvals decide what runs.
        permissionMode: agentMode(session.mode),
        // Its kelpie tools are its review threads and the Workbench, as itself.
        allowedTools: [...scratchRules, 'mcp__kelpie'],
        // The person's own servers, beside Kelpie's (still only these: --strict-mcp-config). None of
        // their tools is allowed by rule; an ask rule sends every call to the person, auto mode too.
        mcpConfig: own ? [...mcpConfig, JSON.stringify({ mcpServers: own.servers })] : mcpConfig,
        ...(own ? { askTools: [...Object.keys(own.servers).map(askRule), ...(artifacts ? ARTIFACT_TOOLS : [])] } : {}),
        ...(denied.length ? { disallowedTools: denied } : {}),
        ...(scratch ? { addDirs: [scratch] } : {}),
        ...connected,
        // The person's one browser, shared by every agent given it: only when the orchestrator asked.
        // Its tools are asked about like any other (auto mode's checks, or the person); none is allowed by rule.
        browser: session.browser,
        appendSystemPrompt:
          (session.kind === 'muster' && place ? musterPrompt(place) : agentPrompt(session.writes, place, scratch, session.browser, artifacts)) + preface,
      };
    }
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
      tools: [...ORCHESTRATOR_TOOLS, ASK_TOOL, ...(scratch ? SCRATCH_TOOLS : []), ...(planning ? ['ExitPlanMode'] : [])],
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
      mcpConfig,
      ...connected,
      appendSystemPrompt: orchestratorPrompt(scratch, session.mode, this.maxAgents) + preface,
    };
  }

  observe(session: Session, _index: number, event: KelpieEvent): void {
    if (event.kind === 'process.exited') {
      const token = this.tokenOfRun.get(event.runId);
      if (token) this.tokens.delete(token);
      this.tokenOfRun.delete(event.runId);
    }
    if (event.kind === 'activity' && !event.data.busy && session.role === 'agent') {
      if (session.parentId) {
        this.schedule(session.parentId);
        // Its Changes tab may show new work, and threads on its diff may sit elsewhere now.
        this.sessions?.publish({ type: 'changes', roundUpId: session.parentId, sessionId: session.id });
        this.reviewMoved(session.parentId);
      }
      // A slot or the repo may have freed up for an agent waiting to resume.
      if (this.waiting.size) void this.resumeWaiting();
    }
  }

  autoResume(): boolean {
    return this.settings.get().autoResume;
  }

  /**
   * After the usage limit reset: a sub-agent waits its turn under the agent limit (and the writer
   * and browser guards); the orchestrator is told which of its agents were paused too.
   */
  async resumeLimited(session: Session): Promise<void> {
    if (session.role === 'agent' && session.parentId) {
      this.waiting.set(session.id, 'limit');
      return this.resumeWaiting();
    }
    const since = session.limited?.since ?? 0;
    const agents = this.manager.children(session.id).filter((c) => c.limited || this.manager.limits.resumedSince(c.id, since));
    await session.resumeAfterLimit(limitResumed(agents.map((a) => ({ agentId: a.id, title: a.title }))));
    // Agents that finished while it was paused.
    this.schedule(session.id);
  }

  /**
   * An agent paused at the usage limit isn't news for its orchestrator; one that won't resume on its
   * own is. An orchestrator whose own pause is over gets what was held for it meanwhile.
   */
  limitChanged(session: Session): void {
    if (session.role === 'agent' && session.parentId && !session.working) this.schedule(session.parentId);
    else if (session.role === 'orchestrator' && !session.limited) this.schedule(session.id);
  }

  /**
   * Before a harness starts: its worktree is on disk, at its one path (a swept one comes back), and
   * the connected services' credentials are read afresh (a gh login may have changed since).
   */
  async prepare(session: Session): Promise<void> {
    const row = this.worktreeAt(session);
    if (row && this.worktrees) {
      // A reader looking at another agent's worktree must not bring back one whose work was mustered:
      // that would cut a fresh, empty branch in its place.
      if (row.kind === 'agent' && row.sessionId !== session.id && row.state === 'mustered') {
        throw new Error(`the worktree "${session.title}" was reading has been mustered into the feature branch; look there instead`);
      }
      await this.worktrees.ensure(row);
    }
    if (this.connections) this.envs.set(session.id, await this.connections.env());
    // A claude.ai connector's entry comes from asking Claude Code, once per repo.
    const settings = this.settings.get();
    if (session.role === 'agent' && settings.useUserMcp && settings.mcpAllow.length && this.mcpServers) {
      await this.mcpServers.ensure(this.roundUpCwd(session), settings.mcpAllow);
    }
  }

  /**
   * "Allow for round-up" rules for a person's MCP tool hold only while the server they were saved
   * for is allowed as it was: revoked, allowed anew (a changed entry, or another server of the name),
   * or the switch off, and every round-up's rules for that server's tools go. Agents running now ask
   * Kelpie about each call (the ask rule), which no longer finds them.
   */
  private mcpGrantsChanged(next: Settings, prev: Settings): void {
    const grants = (s: typeof next) => (s.useUserMcp ? s.mcpAllow : []);
    const byName = (list: typeof next.mcpAllow) => {
      const m = new Map<string, string[]>();
      for (const g of list) m.set(g.name, [...(m.get(g.name) ?? []), JSON.stringify([g.scope, g.repo ?? '', g.fingerprint])].sort());
      return m;
    };
    const before = byName(grants(prev));
    const after = byName(grants(next));
    const changed = [...before.keys()].filter((name) => JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name)));
    // Another server taking a name, with tools of the same names: any rules for that name were someone else's.
    for (const name of after.keys()) if (!before.has(name)) changed.push(name);
    this.store.deleteRulesStartingWith(changed.map((name) => `mcp__${mcpToolPrefix(name)}__`));
  }

  /** The repo checkout of an agent's round-up: whose project and local MCP servers it gets (a worktree has none of its own in ~/.claude.json). */
  private roundUpCwd(agent: Session): string {
    return (agent.parentId && this.sessions?.get(agent.parentId)?.cwd) || agent.cwd;
  }

  /**
   * The person's MCP servers an agent gets, as an `mcpServers` map: those they allowed, exactly as
   * allowed (where configured, and what they run), while the setting is on; with their tools that
   * change things. Undefined for none.
   */
  private personsServers(agent: Session): { servers: Record<string, { type?: unknown }>; writes: string[] } | undefined {
    const settings = this.settings.get();
    if (!this.mcpServers || !settings.useUserMcp || !settings.mcpAllow.length) return undefined;
    const { servers, skipped, writes } = this.mcpServers.forAgents(this.roundUpCwd(agent), settings.mcpAllow);
    for (const { name, reason } of skipped) this.mcpServers.warnOnce(`kelpie: not giving agents your MCP server "${name}": ${reason}`);
    return Object.keys(servers).length ? { servers, writes } : undefined;
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
   * folder, are always fine; anything else is refused. Its plan and its questions go to the person.
   * An agent's requests all go to the person.
   */
  decide(session: Session, req: EventData<'permission.requested'>): PermissionAnswer | undefined {
    if (session.role !== 'orchestrator') return undefined;
    if (req.tool === ASK_TOOL) return undefined;
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

  /** An orchestrator whose agents the person stopped hears it with its next turn, whoever sends it: once. */
  notice(session: Session): string | undefined {
    const resumed = this.resumedNotes.get(session.id);
    if (resumed) {
      this.resumedNotes.delete(session.id);
      return resumed;
    }
    if (!this.untold.delete(session.id) || !session.halted) return undefined;
    return haltNote(this.manager.children(session.id).filter((c) => c.halted).map((c) => ({ agentId: c.id, title: c.title })));
  }

  /** Workbench notes waiting for a session go with the next turn Kelpie or its orchestrator sends it. */
  inbox(session: Session): string | undefined {
    return this.workbench.inbox(session);
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

  /** The session (an orchestrator, or an agent) a bearer token belongs to, while its process runs. */
  authorize(token: string | undefined): Session | undefined {
    const id = token ? this.tokens.get(token) : undefined;
    return id ? this.manager.get(id) : undefined;
  }

  // ── tools ────────────────────────────────────────────────────────────

  /** `alsoInTx` runs in the transaction that queues the brief (e.g. assigning it review threads). */
  async spawn(parent: Session, input: SpawnInput, internal: { alsoInTx?: (agentId: string) => void } = {}): Promise<{ agentId: string; status: string }> {
    const harness = Harness.safeParse(input.harness ?? 'claude-code');
    if (!harness.success) throw new ToolError(`unknown harness "${input.harness}"; available: ${Harness.options.join(', ')}`);
    if (!input.task.trim()) throw new ToolError('task is empty: give the agent a complete brief');
    this.checkHalted(parent);
    if (input.writes && parent.mode === 'plan') throw new ToolError(PLANNING);
    if (input.browser && parent.mode === 'plan') throw new ToolError(PLANNING_BROWSER);
    const files = this.filesFrom(parent, input.files);
    const send = async (child: Session) => {
      // The person stopped everything while it was being made: it never starts.
      if (parent.halted) {
        await this.manager.delete(child.id);
        throw new ToolError(HALTED);
      }
      return child.send(input.task, 'orchestrator', {
        ...(files.length ? { attachments: files } : {}),
        ...(internal.alsoInTx ? { alsoInTx: () => internal.alsoInTx!(child.id) } : {}),
      });
    };
    // One line: it heads notifications and the UI.
    const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Agent';
    const opts = {
      parentId: parent.id,
      role: 'agent' as const,
      writes: input.writes,
      title,
      // The person's choices for the round-up, unless the orchestrator picked others for this unit.
      ...((input.model || parent.model) ? { model: input.model || parent.model } : {}),
      ...((input.effort ?? parent.effort) ? { effort: input.effort ?? parent.effort } : {}),
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
      ...(parent.model ? { model: parent.model } : {}),
      ...(parent.effort ? { effort: parent.effort } : {}),
      maxAgents: this.maxAgents,
      working: this.busy(parent),
      agents: this.manager.children(parent.id).map((c) => this.agentInfo(c)),
      ...untitled(parent.tickets()),
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
    this.checkHalted(parent);
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
      // Half a merge or rebase can't be mustered, and isn't committed as if it were done.
      const op = row.state === 'active' && existsSync(row.path) ? await operationIn(row.path) : undefined;
      if (op) throw new ToolError(`"${agent.title}" has a ${op} in progress in its worktree: ask it to finish or abort it, then muster`);
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
      if (merged.length) this.changesIn(parent.id);
      try {
        // The person may have stopped everything while Kelpie merged.
        this.checkHalted(parent);
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
        // The person's choices for the round-up, as spawned agents get them.
        ...(parent.model ? { model: parent.model } : {}),
        ...(parent.effort ? { effort: parent.effort } : {}),
      });
      await this.reserving(muster, () => muster.send(this.musterBrief(live, rest, result.conflicts, notes), 'orchestrator'));
      return { merged, muster: { agentId: muster.id, branches: rest.map((r) => r.row.branch), conflicts: result.conflicts } };
    }
    if (merged.length) this.changesIn(parent.id);
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

  async message(parent: Session, agentId: string, text: string, paths?: string[], alsoInTx?: () => void): Promise<{ status: string }> {
    const child = this.child(parent, agentId);
    if (!text.trim()) throw new ToolError('text is empty');
    this.checkHalted(parent);
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
    await this.reserving(child, () => child.send(text, 'orchestrator', { ...(files.length ? { attachments: files } : {}), ...(alsoInTx ? { alsoInTx } : {}) }));
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

  /**
   * Hands open review threads to a writer: one of the round-up's (picked up again, its worktree
   * brought back from the feature branch if it was mustered), or without `agentId` a new one. The
   * assignment lands with its brief, in one transaction.
   */
  async assignThreads(parent: Session, input: { threadIds: string[]; agentId?: string | undefined; title?: string | undefined; notes?: string | undefined }): Promise<{ agentId: string; status: string; threads: number }> {
    if (!input.threadIds.length) throw new ToolError('threadIds is empty: name the open threads to assign');
    const rows = this.reviews.openThreads(parent.id, input.threadIds);
    const ids = rows.map((r) => r.id);
    const threads = await this.reviews.toolThreads(rows, false);
    let result: { agentId: string; status: string };
    if (input.agentId) {
      const child = this.child(parent, input.agentId);
      if (!child.writes || child.kind !== 'worker') {
        throw new ToolError(`"${child.title}" ${child.kind === 'muster' ? 'is Muster' : 'is read-only'}: review threads go to a writing agent; omit agentId to start one`);
      }
      const r = await this.message(parent, child.id, reviewBrief(threads, { notes: input.notes }), undefined, () => this.store.assignThreads(ids, child.id));
      result = { agentId: child.id, ...r };
    } else {
      result = await this.spawn(
        parent,
        { title: input.title?.trim() || 'Review fixes', task: reviewBrief(threads, { notes: input.notes, fresh: true }), writes: true, deliver: 'muster' },
        { alsoInTx: (agentId) => this.store.assignThreads(ids, agentId) },
      );
    }
    this.reviews.changed(parent.id);
    return { ...result, threads: ids.length };
  }

  /**
   * Whether review threads the person made on an agent's own Changes tab can go straight to it now,
   * by message_agent's rules: the agent, its slot held (counted by the cap and writer guard) until
   * `release`, or why not, in a few words.
   */
  claimForReview(parent: Session, agentId: string): ReviewClaim {
    const child = this.manager.get(agentId);
    if (!child || child.parentId !== parent.id) return { reason: 'that agent was deleted' };
    if (child.kind === 'muster') return { reason: `"${child.title}" is Muster` };
    if (!child.writes) return { reason: `"${child.title}" is read-only` };
    if (parent.mode === 'plan') return { reason: 'the round-up is in plan mode, so writers wait' };
    if (parent.halted) return { reason: "you stopped this round-up's agents: resume them first" };
    if (!this.isWorking(child)) {
      if (this.slotsLeft(parent) <= 0) return { reason: capReason(this.maxAgents, this.busy(parent)) };
      const writer = this.busyWriter(child.cwd, child.id);
      if (writer) return { reason: `writing agent "${writer.title}" is working in the same place` };
      const browser = child.browser ? this.browserInUse(parent, child.id) : undefined;
      if (browser) return { reason: browser };
    }
    const held = !this.reserved.has(child.id);
    if (held) this.reserved.add(child.id);
    // Picked up now: no restart turn later.
    this.waiting.delete(child.id);
    child.clearResumePending();
    return { agent: child, release: () => held && this.reserved.delete(child.id) };
  }

  /** Links a Jira or Asana ticket to the round-up, or titles one already linked (never over the person's own title). */
  linkTicket(parent: Session, url: string, title?: string): { tickets: LinkedTicket[]; note?: string } {
    const t = parseTicketUrl(url);
    if (!t) throw new ToolError(`not a Jira issue or Asana task or project link: ${url}. Pass the ticket's own page, e.g. https://<org>.atlassian.net/browse/KEY-123 or https://app.asana.com/0/<project>/<task>.`);
    parent.linkTickets([t], 'orchestrator', title);
    const tickets = parent.tickets();
    const named = tickets.find((x) => x.ref === t.ref);
    const kept = !!title?.trim() && named?.titleSource === 'person' && named.title !== title.trim();
    return { tickets, ...(kept ? { note: 'The person named this ticket themselves, so their title stays.' } : {}) };
  }

  /** Unlinks a ticket from the round-up, by any link to it. */
  unlinkTicket(parent: Session, url: string): { tickets: LinkedTicket[] } {
    const t = parseTicketUrl(url);
    if (!t || !parent.unlinkTicket(t.ref)) throw new ToolError(`no such ticket is linked to this round-up: ${url}`);
    return { tickets: parent.tickets() };
  }

  async interrupt(parent: Session, agentId: string): Promise<{ status: string }> {
    const child = this.child(parent, agentId);
    await child.interrupt();
    return { status: child.working ? 'working' : 'idle' };
  }

  // ── stop all, resume all ─────────────────────────────────────────────

  /**
   * The person's "Stop all": every agent of the round-up that is working, starting, waiting for a slot
   * or due to resume after the usage limit stops, and is marked stopped by the person; with
   * `orchestrator` (the default) its own turn too. Until they resume, the orchestrator may not start or
   * message agents, and it hears why once: with its next turn, or now if its turn goes on. Nothing of
   * it resumes on its own, a restart included.
   */
  stopAll(parent: Session, opts: { orchestrator?: boolean } = {}): Promise<{ agents: string[]; orchestrator: boolean }> {
    if (parent.parentId) return Promise.reject(new Error("stop the agent's round-up, not the agent"));
    return this.oneAtATime(parent.id, () => this.halt(parent, opts.orchestrator !== false));
  }

  /**
   * The person's "Resume all": the agents they stopped continue where they left off, as many as the
   * agent limit allows now and the rest as slots free up (one paused at the usage limit once it
   * resets), and the orchestrator is told once (which picks its own turn up again too).
   */
  resumeAll(parent: Session): Promise<{ resumed: string[]; queued: string[] }> {
    if (parent.parentId) return Promise.reject(new Error("resume the agent's round-up, or the agent on its own"));
    return this.oneAtATime(parent.id, () => this.unhalt(parent));
  }

  /**
   * Resumes one agent the person stopped. The last of them resumes the whole round-up (its
   * orchestrator may work again); before that, the orchestrator stays stopped.
   */
  resumeAgent(agent: Session): Promise<{ resumed: string[]; queued: string[] }> {
    const parent = agent.parentId ? this.manager.get(agent.parentId) : undefined;
    if (!parent) return Promise.reject(new Error('only an agent of a round-up can be resumed on its own'));
    return this.oneAtATime(parent.id, async () => {
      if (!agent.halted) throw new Error('it was not stopped by you');
      if (parent.halted && this.manager.children(parent.id).every((c) => c === agent || !c.halted)) return this.unhalt(parent);
      const { queued } = await this.resumeAgents([agent]);
      parent.note('halt', { action: 'resumed', agents: 1 });
      return { resumed: [agent.id], queued };
    });
  }

  /**
   * The person sent an agent a turn of their own. One they stopped is picked up by it, as if they had
   * resumed it (the last of them resumes the round-up); one in line to resume needs Kelpie's turn no more.
   */
  personSent(session: Session): void {
    if (session.role !== 'agent' || !session.parentId) return;
    if (this.waiting.delete(session.id)) session.clearResumePending();
    if (session.halted === undefined) return;
    session.setHalted(undefined);
    const parent = this.manager.get(session.parentId);
    if (!parent) return;
    void this.oneAtATime(parent.id, async () => {
      if (parent.halted && !this.manager.children(parent.id).some((c) => c.halted)) await this.unhalt(parent, [session]);
      else parent.note('halt', { action: 'resumed', agents: 1 });
    }).catch((err) => console.error(`round-up ${parent.id}: could not resume`, err));
  }

  /** Runs `op` once whatever Stop all or Resume all of the round-up is going has finished. */
  private oneAtATime<T>(roundUpId: string, op: () => Promise<T>): Promise<T> {
    const next = (this.haltOps.get(roundUpId) ?? Promise.resolve()).then(op, op);
    this.haltOps.set(roundUpId, next);
    const done = () => {
      if (this.haltOps.get(roundUpId) === next) this.haltOps.delete(roundUpId);
    };
    next.then(done, done);
    return next;
  }

  private async halt(parent: Session, own: boolean): Promise<{ agents: string[]; orchestrator: boolean }> {
    const now = Date.now();
    parent.setHalted(parent.halted ?? now);
    const limits = this.manager.limits;
    const stopping = this.manager
      .children(parent.id)
      .filter((c) => !c.halted && (this.isWorking(c) || c.launching || this.waiting.has(c.id) || limits.willResume(c.id)));
    for (const c of stopping) {
      c.setHalted(now);
      this.waiting.delete(c.id);
      c.clearResumePending();
      limits.cancel(c.id);
    }
    // Starting counts: its turn is on its way.
    const running = parent.working || parent.launching;
    if (own) limits.cancel(parent.id);
    const stopsOwn = own && running;
    const interrupted = await Promise.allSettled([...stopping.map((c) => c.interrupt()), ...(stopsOwn ? [parent.interrupt()] : [])]);
    interrupted.forEach((r) => r.status === 'rejected' && console.error(`round-up ${parent.id}: could not stop`, r.reason));
    parent.note('halt', { action: 'stopped', agents: stopping.length, ...(stopsOwn ? { orchestrator: true } : {}) });
    this.resumedNotes.delete(parent.id);
    if (running && !stopsOwn) {
      // Its turn goes on: it hears now, after that turn, rather than at whatever it does next.
      const told = this.manager.children(parent.id).filter((c) => c.halted).map((c) => ({ agentId: c.id, title: c.title }));
      this.untold.delete(parent.id);
      this.notifyInTurn(parent.id, () => parent.send(haltNote(told), 'kelpie', { meta: { halt: 'stopped' } }));
    } else {
      // Stopped too (it may still read as working while its turn winds down), or idle: it hears with its next turn.
      this.untold.add(parent.id);
    }
    return { agents: stopping.map((c) => c.id), orchestrator: stopsOwn };
  }

  /**
   * Lifts the round-up's stop: its stopped agents resume, and the orchestrator hears which once.
   * `picked`: agents the person picked up themselves (by messaging them), resumed already.
   */
  private async unhalt(parent: Session, picked: Session[] = []): Promise<{ resumed: string[]; queued: string[] }> {
    const halted = this.manager.children(parent.id).filter((c) => c.halted);
    parent.setHalted(undefined);
    this.untold.delete(parent.id);
    const { queued, paused } = await this.resumeAgents(halted);
    const all = [...picked, ...halted];
    parent.note('halt', { action: 'resumed', agents: all.length });
    const text = haltResumed(all.map((c) => ({ agentId: c.id, title: c.title })), queued.length, paused.length);
    // Its own pause at the usage limit, which Stop all kept from resuming on its own: it does again, and hears then.
    if (parent.limited && this.autoResume() && this.manager.limits.restore(parent.id)) this.resumedNotes.set(parent.id, text);
    else this.notifyInTurn(parent.id, () => parent.send(text, 'kelpie', { meta: { resumed: 'halt' } }));
    // What agents finished meanwhile, held while it was stopped.
    this.schedule(parent.id);
    return { resumed: all.map((c) => c.id), queued };
  }

  /**
   * Puts stopped agents back in line to continue, under the agent limit. One paused at the usage limit
   * resumes on its own again, once that resets. Returns those still waiting for a slot, and for the limit.
   */
  private async resumeAgents(agents: Session[]): Promise<{ queued: string[]; paused: string[] }> {
    const paused: string[] = [];
    for (const c of agents) {
      c.setHalted(undefined);
      if (c.limited && this.autoResume() && this.manager.limits.restore(c.id)) {
        paused.push(c.id);
        continue;
      }
      // A restart before it gets a slot still resumes it.
      c.markResumePending();
      this.waiting.set(c.id, 'halt');
    }
    await this.resumeWaiting();
    return { queued: agents.filter((c) => this.waiting.has(c.id)).map((c) => c.id), paused };
  }

  // ── recovery ─────────────────────────────────────────────────────────

  /**
   * After a daemon start: resumes every round-up that was working when Kelpie stopped
   * (sub-agents first, as the cap and writer guard allow), and sends each orchestrator the
   * notifications it was still owed.
   */
  async recover(): Promise<void> {
    // Also anything with turns it never took in (e.g. killed in the instant after a send).
    // Never what the person stopped: that waits for them to resume it.
    const pending = this.manager.all().filter((s) => !(s.role === 'agent' && s.halted) && (s.resumePending || this.store.undelivered(s.id).length > 0));
    // A stopped round-up whose orchestrator never heard of it before Kelpie stopped hears with its next turn.
    for (const s of this.manager.all()) if (!s.parentId && s.halted !== undefined && !this.toldOfHalt(s)) this.untold.add(s.id);
    for (const agent of pending.filter((s) => s.role === 'agent')) this.waiting.set(agent.id, 'restart');
    await this.resumeWaiting();
    await Promise.all(pending.filter((s) => s.role === 'orchestrator').map((s) => s.resumeAfterRestart(ORCHESTRATOR_RESTARTED)));
    const parents = new Set(this.manager.all().flatMap((s) => (s.parentId ? [s.parentId] : [])));
    for (const id of parents) this.schedule(id);
    // Work paused at the usage limit: what is due resumes now, the rest when its limit resets.
    this.manager.startLimits();
  }

  /** Whether a turn carrying the stop note went to (or waits for) the orchestrator since its round-up was stopped. */
  private toldOfHalt(parent: Session): boolean {
    return this.store.sentSince(parent.id, parent.halted ?? 0).some((r) => hasHaltNote(r.text));
  }

  /**
   * Resumes the agents waiting to, as far as the cap and the guards allow. One pass at a time: a call
   * while one runs shares the single pass queued after it, which sees what the first one started.
   */
  private resumeWaiting(): Promise<void> {
    this.resumeQueued ??= this.resumes.then(() => {
      this.resumeQueued = undefined;
      return this.resumePass();
    });
    this.resumes = this.resumeQueued;
    return this.resumeQueued;
  }

  private async resumePass(): Promise<void> {
    for (const [id, why] of [...this.waiting]) {
      const agent = this.manager.get(id);
      const parent = agent?.parentId ? this.manager.get(agent.parentId) : undefined;
      // One paused at the limit may have been picked up meanwhile, or the person said not to resume it.
      // Or the person stopped it (again), or picked it up themselves.
      if (!agent || !parent || agent.halted || (why === 'limit' && (agent.working || !this.manager.limits.willResume(id)))) {
        this.waiting.delete(id);
        continue;
      }
      // Still winding down the turn it was stopped in: it goes once idle (whoever picks it up first clears it).
      if (why === 'halt' && agent.working) continue;
      if (this.slotsLeft(parent) <= 0) continue;
      if (agent.writes && this.busyWriter(agent.cwd, agent.id)) continue;
      if (agent.browser && this.browserInUse(parent, agent.id)) continue;
      this.waiting.delete(id);
      try {
        // Counted from here: its process takes a moment to start working, and the cap must count it meanwhile.
        await this.reserving(agent, () =>
          why === 'limit'
            ? agent.resumeAfterLimit(LIMIT_RESUMED)
            : why === 'halt'
              ? agent.resumeAfterHalt(AGENT_HALT_RESUMED)
              : agent.resumeAfterRestart(AGENT_RESTARTED),
        );
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
      // Refused while Kelpie shuts down: the next start sends it (it goes by notifiedIdx).
      this.notifyInTurn(parentId, () => this.flush(parentId));
    }, this.notifyDelayMs);
    timer.unref();
    this.timers.set(parentId, timer);
  }

  /** Sends an orchestrator a notification after any still going out to it. */
  private notifyInTurn(parentId: string, send: () => Promise<void>): void {
    const next = (this.flushes.get(parentId) ?? Promise.resolve())
      .then(send)
      .catch((err) => console.error(`orchestrator ${parentId}: notification not sent:`, (err as Error).message));
    this.flushes.set(parentId, next);
    void next.finally(() => this.flushes.get(parentId) === next && this.flushes.delete(parentId));
  }

  /**
   * The person raised the agent limit: agents waiting to resume start, as far as it now allows, and
   * each orchestrator that was refused for the cap (and not notified since) hears there is room.
   */
  private limitRaised(): void {
    // Agents waiting to resume go first: the room the notice offers is what they leave.
    void this.resumeWaiting().then(() => this.offerRoom());
  }

  private offerRoom(): void {
    for (const id of [...this.capped]) {
      const parent = this.sessions?.get(id);
      if (!parent) {
        this.capped.delete(id);
        continue;
      }
      if (this.slotsLeft(parent) <= 0 || parent.halted) continue;
      this.capped.delete(id);
      this.notifyInTurn(id, async () => {
        // An idle notification may have gone out meanwhile, or the room been taken.
        const room = this.slotsLeft(parent);
        if (room <= 0 || !this.sessions?.get(id)) return;
        await parent.send(limitNotice(this.maxAgents, this.busy(parent), room), 'kelpie');
      });
    }
  }

  /** Tells the orchestrator about every sub-agent that went idle since it was last told. */
  private async flush(parentId: string): Promise<void> {
    const parent = this.manager.get(parentId);
    // Paused at the usage limit itself: what it is owed goes once its pause is over (limitChanged).
    // Stopped by the person: once they resume it.
    if (!parent || parent.limited || parent.halted) return;
    const owed = this.manager.children(parentId).flatMap((c) => {
      // Paused at the usage limit, it will pick up on its own: news once it is done (or won't resume).
      if (this.isWorking(c) || this.waiting.has(c.id) || this.manager.limits.willResume(c.id)) return [];
      const idle = this.store.lastEventAt(c.id, 'activity');
      return idle && !idle.event.data.busy && idle.index > c.notifiedIdx ? [{ agent: c, index: idle.index }] : [];
    });
    if (!owed.length) return;
    const home = this.store.worktreeOf(parentId);
    const agents: (AgentUpdate & { report: string })[] = [];
    for (const { agent } of owed) {
      const r = report(agent.events());
      const review = this.reviews.countsFor(parentId, agent.id);
      agents.push({
        agentId: agent.id,
        title: agent.title,
        status: agent.limited ? 'paused at the usage limit (the person can resume it)' : (r.lastTurn ?? 'not started'),
        report: r.report,
        ...(r.error ? { error: r.error } : {}),
        ...(r.filesChanged.length ? { filesChanged: r.filesChanged } : {}),
        ...(await this.branchOf(agent, home)),
        ...(review ? { reviewThreads: review } : {}),
      });
    }
    // Muster's outcome is what git says is in the feature branch, not what its report claims.
    // If git fails, the agents' news still goes; their branches settle on the next pass.
    const mustered = owed.some(({ agent }) => agent.kind === 'muster')
      ? await this.settleMuster(parentId).catch((err) => void console.error(`round-up ${parentId}: could not settle its mustered branches`, err))
      : undefined;
    // Sent and marked in one transaction: after a crash it is neither lost nor sent twice.
    // It can try again on this one: no separate word when the limit is raised.
    this.capped.delete(parentId);
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
      const stats = await this.worktrees.stats(row);
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
      if (!agent || this.isWorking(agent) || agent.resumePending) continue;
      if (await this.worktrees.musteredIn(row, home)) {
        await this.worktrees.mustered(row, home);
        agent.summaryChanged();
        out.merged.push(agent.title);
      } else if ((await this.worktrees.ownCommits(row)) > 0) out.pending.push(agent.title);
    }
    if (out.merged.length) this.changesIn(parentId);
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
    // Branches merged just before a crash, never marked mustered (or recorded as delivered): settled now.
    for (const home of this.store.allWorktrees().filter((r) => r.kind === 'home')) {
      if (!this.manager.get(home.roundUpId)) continue;
      await this.settleMuster(home.roundUpId).catch((err) => console.error(`round-up ${home.roundUpId}: could not settle its mustered branches`, err));
    }
  }

  /** The feature branch moved: its Changes tab should refetch, and its threads may have moved or gone outdated. */
  private changesIn(roundUpId: string): void {
    this.sessions?.publish({ type: 'changes', roundUpId, sessionId: roundUpId });
    this.reviewMoved(roundUpId);
  }

  /** A diff under a round-up's threads changed: where they sit (and whether outdated) goes out again, if it has any. */
  private reviewMoved(roundUpId: string): void {
    if (this.store.threadsOf(roundUpId).length) this.reviews.changed(roundUpId);
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
    // The person stopped it while its turn was on its way: it stops now that it has started.
    if (child.halted) await child.interrupt();
  }

  private checkHalted(parent: Session): void {
    if (parent.halted) throw new ToolError(HALTED);
  }

  /** How many more of a round-up's agents may start now: none, or below, once the limit was lowered under the count working. */
  private slotsLeft(parent: Session): number {
    return this.maxAgents - this.busy(parent);
  }

  /** A round-up's agents the cap counts: working (or cleared to start), and writers whose worktree is still being made. */
  private busy(parent: Session): number {
    return this.working(parent) + (this.starting.get(parent.id) ?? 0);
  }

  private checkCap(parent: Session): void {
    if (this.slotsLeft(parent) <= 0) {
      this.capped.add(parent.id);
      throw new ToolError(capRefusal(this.maxAgents, this.busy(parent)));
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
      ...(c.effort ? { effort: c.effort } : {}),
      kind: c.kind,
      ...(row ? { branch: row.branch, worktree: row.state, ...(row.deliver ? { deliver: row.deliver } : {}) } : {}),
      status: this.isWorking(c)
        ? c.approvals().length
          ? 'needs approval'
          : 'working'
        : c.halted
          ? 'stopped by the person'
          : c.limited
            ? 'paused'
            : this.waiting.has(c.id)
              ? 'waiting'
              : 'idle',
      ...(!this.isWorking(c) && c.limited?.retryAt ? { resumesAt: new Date(c.limited.retryAt).toISOString() } : {}),
      lastTurn: c.lastTurn,
      updatedAt: new Date(info.updatedAt).toISOString(),
      costUsd: Math.round(this.store.costOf(c.id) * 10_000) / 10_000,
    };
  }
}

const agents = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;

/** Why no more agents may start: `busy` of them count against the person's `max`, maybe more after they lowered it. */
export function capReason(max: number, busy: number): string {
  const now = busy <= max ? `${agents(busy)} ${busy === 1 ? 'is' : 'are'} already working` : `${agents(busy)} are working and the limit is now ${max}`;
  return `${now}: the person allows at most ${agents(max)} at once (they set this in Kelpie's Settings)`;
}

/** spawn_agent's and message_agent's refusal at the cap. */
export function capRefusal(max: number, busy: number): string {
  return `${capReason(max, busy)}. End your turn; you will be notified as they finish.`;
}

/** Tells an orchestrator refused at the cap that the person raised it. */
export function limitNotice(max: number, working: number, room: number): string {
  return `<${NOTIFICATION_TAG}>\nThe person raised the limit to ${agents(max)} working at once. ${working} working now, so ${room === 1 ? 'one more' : `${room} more`} can start: go ahead with the work that was waiting for a free slot.\n\nThis message is from Kelpie, not the person.\n</${NOTIFICATION_TAG}>`;
}

/** What the orchestrator reads; the UI renders the same agents from the echo's `agents` and this text. */
function notification(agents: (AgentUpdate & { report: string })[], mustered?: { merged: string[]; pending: string[] }): string {
  const body = agents.map((a) => {
    const text = a.report.length > REPORT_CHARS ? `${a.report.slice(0, REPORT_CHARS)}…\n(report cut; read_agent has all of it)` : a.report;
    const files = a.filesChanged ? `\nFiles changed: ${a.filesChanged.map((f) => `${f.path} (+${f.added} -${f.removed})`).join(', ')}` : '';
    const error = a.error ? `\nError: ${a.error}` : '';
    const review = a.reviewThreads ? `\nReview threads: ${a.reviewThreads.resolved} resolved, ${a.reviewThreads.open} open` : '';
    const branch = a.branch
      ? `\nBranch: ${a.branch} (${a.ahead ?? 0} commit${a.ahead === 1 ? '' : 's'} ahead of the feature branch${a.diffstat ? `; ${a.diffstat}` : ''}; ${a.deliver === 'standalone' ? 'standalone' : 'to muster'})`
      : '';
    return `## Agent "${a.title}" (${a.agentId}) is idle: turn ${a.status}${error}${files}${branch}${review}\n\n${text || '(no report)'}`;
  });
  const settled = mustered
    ? `\n\nIn the feature branch now (checked with git): ${mustered.merged.join(', ') || 'nothing new'}.${mustered.pending.length ? ` Still not mustered: ${mustered.pending.join(', ')}.` : ''}`
    : '';
  return `<${NOTIFICATION_TAG}>\n${body.join('\n\n')}${settled}\n\nThis message is from Kelpie, not the person. Use read_agent for more detail.\n</${NOTIFICATION_TAG}>`;
}
