import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { attachmentsBlock, findTickets, mergeUsage, ticketsNote, type LinkedTicket, type TicketLink, type TicketTitleSource, type Answers, type Attachment, type EventOf, type Question, type Mode, type EventData, type EventKind, type HarnessUsage, type KelpieEvent, type TodoItem, type Settings, type WorkbenchCard, type UsageLimitPause } from '@kelpie/protocol';
import { claudeCode, isChromeTool, type Adapter, type PermissionAnswer, type Run, type RunSpec } from '@kelpie/adapters';
import type { AttachmentRow, OutboxSource, SessionPatch, SessionRow, Store, TicketRow, TicketSource } from '@kelpie/store';
import { nowOf, SUMMARY_KINDS, type AgentSummary, type Now } from './agent-summary.js';
import type { ReviewState } from './review/types.js';
import { LIMIT_RESUMED, UsageLimits, type LimitTiming } from './usage-limits.js';

export type TurnStatus = EventData<'turn.ended'>['status'];

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms of the last logged event, or of creation. */
  updatedAt: number;
  busy: boolean;
  /** How the most recent turn ended, if any has. */
  lastTurn: TurnStatus | undefined;
  /** The harness's own session id, once known; reused to resume after the process exits. */
  harnessSessionId: string | undefined;
  harness: string;
  /** The orchestrator that spawned this sub-agent; undefined for a top-level round-up. */
  parentId: string | undefined;
  role: 'orchestrator' | 'agent';
  /** A sub-agent allowed to change files. */
  writes: boolean;
  /** A sub-agent given the Claude in Chrome tools (the person's own browser). */
  browser: boolean;
  /** The model asked for, if not the harness's default. */
  model: string | undefined;
  /** A sub-agent's job: ordinary work, or Muster. */
  kind: 'worker' | 'muster';
  /** An orchestrator's base branch and the commit it is pinned to, once chosen. */
  baseBranch: string | undefined;
  baseCommit: string | undefined;
  /** The round-up's mode; a sub-agent reports its round-up's. */
  mode: Mode;
  /** Jira and Asana tickets linked to a top-level round-up, in the order they were linked; none on a sub-agent. */
  tickets: LinkedTicket[];
  /** A sub-agent's own branch and its worktree's state, as in its AgentSummary: whether its work still waits to be mustered. */
  branch?: string;
  deliver?: 'muster' | 'standalone';
  worktree?: 'creating' | 'active' | 'mustered' | 'removed';
  /** Paused because its harness hit the person's usage limit: Kelpie resumes it once that resets. */
  limited?: UsageLimitPause;
  /**
   * When the person stopped it with "Stop all" (epoch ms). On a round-up: its orchestrator may not
   * start or message agents until they resume it. On a sub-agent: "Resume all" picks it up again.
   */
  halted?: number;
}

/** What subscribers receive. `index` is the event's position in the session log (stable across runs and restarts). */
export interface SessionUpdate {
  index: number;
  event: KelpieEvent;
}

/** A harness waiting on the person: a permission request still open, with whose it is. */
export interface PendingApproval {
  roundUpId: string;
  sessionId: string;
  /** The agent asking (or the round-up itself, for its plan). */
  agentTitle: string;
  requestId: string;
  tool: string;
  title: string;
  input: unknown;
  rule?: string;
  plan?: string;
  /** Questions it puts to the person (AskUserQuestion), answered with `answers` rather than a yes. */
  questions?: Question[];
  /** When it was asked (ISO). */
  ts: string;
}

/** What answering a batch of approvals did to each one. */
export interface ApprovalResult {
  sessionId: string;
  requestId: string;
  ok: boolean;
  error?: string;
}

/** The message an agent gets when the person says no without one. */
export const DENIED = "The person declined this. Don't retry it or work around it; say in your report what you needed it for.";

/** The message an agent gets when the person skips its questions. */
export const SKIPPED =
  "The person skipped these questions without answering. Don't ask them again; go with your best judgment, and say in your report what you assumed.";

/**
 * Why `answers` can't answer `questions`, or undefined if they can: every answer is to one of the
 * questions, non-empty, and a list only for a multi-select one; at least one question is answered.
 */
export function answersError(questions: Question[], answers: Answers): string | undefined {
  const byText = new Map(questions.map((q) => [q.question, q]));
  const entries = Object.entries(answers);
  if (!entries.length) return 'answer at least one of the questions';
  for (const [text, answer] of entries) {
    const q = byText.get(text);
    if (!q) return `not one of the questions: ${text}`;
    const parts = Array.isArray(answer) ? answer : [answer];
    if (Array.isArray(answer) && !q.multiSelect) return `"${text}" takes one answer`;
    if (!parts.length || parts.some((p) => typeof p !== 'string' || !p.trim() || p.length > 4000)) return `"${text}" needs an answer (at most 4000 characters each)`;
    if (parts.length > q.options.length + 1) return `"${text}" has more answers than options`;
    if (q.kind === 'number') {
      const n = Number(parts[0]!.trim());
      if (!/^-?\d+(\.\d+)?$/.test(parts[0]!.trim()) || (q.min !== undefined && n < q.min) || (q.max !== undefined && n > q.max)) {
        return `"${text}" takes a number${q.min !== undefined && q.max !== undefined ? ` between ${q.min} and ${q.max}` : ''}`;
      }
    }
  }
  return undefined;
}

/** What the round-up list stream carries. */
export type ManagerUpdate =
  | { type: 'session'; session: SessionInfo }
  | { type: 'deleted'; id: string }
  | { type: 'usage'; usage: HarnessUsage[] }
  /** A sub-agent's summary changed (throttled). */
  | { type: 'agent'; agent: AgentSummary }
  /** What a round-up (its orchestrator and agents) is waiting on the person for, now. */
  | { type: 'approvals'; roundUpId: string; approvals: PendingApproval[] }
  /** A round-up's review changed (a comment, a reply, a resolution): its whole state, throttled. */
  | { type: 'review'; roundUpId: string; state: ReviewState }
  /** What `GET /api/sessions/:sessionId/changes` returns may have changed (an agent went idle, a muster merged). */
  | { type: 'changes'; roundUpId: string; sessionId: string }
  /** The person changed their settings: all of them, as they are now. */
  | { type: 'settings'; settings: Settings }
  /** A Workbench card changed (or was made), with what Kelpie derives for it now. */
  | { type: 'card'; card: WorkbenchCard }
  /** A Workbench card is gone (its round-up was deleted). */
  | { type: 'card-removed'; id: string };

/** Run settings a round-up does not decide per process: everything but what `start` fills in. */
export type SessionDefaults = Omit<RunSpec, 'cwd' | 'prompt' | 'resume' | 'todos' | 'runId' | 'runDir'>;

export interface RunContext {
  runId: string;
  /** No harness session to resume: the harness starts without any earlier context. */
  fresh: boolean;
  /** The round-up has been sent turns before, so a fresh start has lost context it had. */
  hadHistory: boolean;
}

/** How round-ups are specialised (the orchestrator's tools and prompts) and watched. */
export interface SessionHooks {
  /** Extra run settings for each harness process; called on every start. */
  specFor?(session: Session, run: RunContext): Partial<SessionDefaults>;
  /** Every event, once it is logged and subscribers have seen it. Must not throw. */
  observe?(session: Session, index: number, event: KelpieEvent): void;
  /** Before each harness process starts: make sure what it runs in exists (e.g. recreate a swept worktree). */
  prepare?(session: Session): Promise<void>;
  /** A round-up (or one sub-agent) is being deleted: its processes are stopped, its rows not yet gone. */
  removing?(session: Session): Promise<void>;
  /** A round-up's mode changed: bring its live processes in line. Without it, its own process switches to the mode. */
  modeChanged?(session: Session): Promise<void>;
  /**
   * Answers a harness's permission request by policy, before the person is asked; undefined leaves it
   * to the person. (Rules the person saved for the round-up are applied before this.) Must not throw.
   */
  decide?(session: Session, request: EventData<'permission.requested'>): PermissionAnswer | undefined;
  /**
   * Text to add to a turn Kelpie or the orchestrator sends (never to the person's own words): e.g.
   * Workbench notes waiting for it. Runs in the transaction that queues the turn, so whatever it
   * hands over is marked as handed over in it.
   */
  inbox?(session: Session): string | undefined;
  /** Whether sessions paused at the usage limit resume on their own once it resets (the person's setting). Default: they do. */
  autoResume?(): boolean;
  /**
   * Resumes a session paused at the usage limit (e.g. a sub-agent once the agent limit has room).
   * Without it, the session is sent LIMIT_RESUMED.
   */
  resumeLimited?(session: Session): Promise<void>;
  /** A session's pause at the usage limit began, changed or ended. Must not throw. */
  limitChanged?(session: Session): void;
  /**
   * Kelpie's word to go with the session's next turn, whoever sends it (the person included): e.g.
   * that the person stopped all its agents. Runs in the transaction that queues the turn.
   */
  notice?(session: Session): string | undefined;
  /** The person sent the session a turn of their own (e.g. picking up an agent they stopped). Must not throw. */
  personSent?(session: Session): void;
}

/** A file sent with a turn, and where the harness finds it. */
export interface SentFile extends Attachment {
  path: string;
}

export interface SendOptions {
  /** Runs in the same transaction as the outbox write (e.g. marking what a notification covers). */
  alsoInTx?: () => void;
  /** Extra `message` data the logged echo of this turn carries. */
  meta?: Record<string, unknown>;
  /** Files listed in the turn by path (the harness reads them itself) and, for the UI, in its echo. */
  attachments?: SentFile[];
  /** Turns for other sessions, queued in the same transaction and sent with this one (e.g. a review's briefs). */
  together?: TogetherTurn[];
}

/** A turn for another session that goes with a `send`: both survive a crash, or neither was queued. */
export interface TogetherTurn {
  session: Session;
  text: string;
  source: OutboxSource;
  meta?: Record<string, unknown>;
}

export interface CreateOptions {
  /** Chosen up front when the id is needed before the session exists (e.g. for its worktree path). */
  id?: string;
  parentId?: string;
  kind?: 'worker' | 'muster';
  baseBranch?: string;
  baseCommit?: string;
  role?: 'orchestrator' | 'agent';
  writes?: boolean;
  /** Give it the Claude in Chrome tools, for every process it runs. */
  browser?: boolean;
  title?: string;
  model?: string;
  mode?: Mode;
}

export interface SessionManagerOptions {
  store: Store;
  defaultCwd: string;
  defaults?: SessionDefaults;
  adapter?: Adapter;
  /** Each run's raw stream goes to `<runsDir>/<runId>`; the adapter's default otherwise. */
  runsDir?: string;
  /** A harness process idle this long is stopped; the next message resumes it. */
  idleMs?: number;
  hooks?: SessionHooks;
  /** Each round-up's scratch folder (uploads, files passed to agents) goes in `<scratchDir>/<roundUpId>`. None without it. */
  scratchDir?: string;
  /** How long resuming after the usage limit waits past a reset, between resumes, and for a probe (shorter in tests). */
  limitTiming?: Partial<LimitTiming>;
}

interface SessionContext {
  store: Store;
  defaults: SessionDefaults;
  adapter: Adapter;
  runsDir: string | undefined;
  scratchDir: string | undefined;
  idleMs: number;
  hooks: SessionHooks;
  /** Set once the daemon is shutting down: nothing may start a harness process any more. */
  closing: boolean;
  changed: (s: Session) => void;
  reportUsage: (harness: string, usage: EventData<'rate_limit'>) => void;
  /** A sub-agent's summary may have changed. */
  agentChanged: (s: Session) => void;
  /** Another round-up (a sub-agent's orchestrator). */
  get: (id: string) => Session | undefined;
  /** What the session is waiting on the person for changed. */
  approvalsChanged: (s: Session) => void;
  /** Sessions paused at the usage limit. */
  limits: UsageLimits;
  /** Stops a session's pause resuming on its own; a round-up's agents' too (see SessionManager.cancelLimits). */
  cancelLimits: (s: Session) => boolean;
}

const ticketOf = (r: TicketRow): LinkedTicket => ({
  ref: r.ref,
  provider: r.provider,
  kind: r.kind,
  url: r.url,
  ...(r.key ? { key: r.key } : {}),
  ...(r.title ? { title: r.title } : {}),
  ...(r.title && r.titleSource ? { titleSource: r.titleSource } : {}),
  source: r.source,
  addedAt: r.createdAt,
});

const STOPPED = 'Kelpie stopped while this run was active.';
const AGENT_UPDATE_MS = 300;
const TITLE_MAX = 60;

/**
 * A file name safe to put on disk and in a path the harness reads: no directories or odd characters,
 * any script's letters kept, and the extension always (the harness goes by it, e.g. to show an image).
 */
export function safeName(name: string): string {
  const base = basename(name.replace(/\\/g, '/'));
  const ext = extname(base).replace(/[^\p{L}\p{N}.]+/gu, '').slice(0, 16);
  const stem = base
    .slice(0, base.length - extname(base).length)
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+/, '')
    .slice(-80);
  return `${stem || 'file'}${ext}`;
}

export function titleFrom(text: string): string {
  const line = (text.trim().split('\n')[0] ?? '').replace(/\s+/g, ' ');
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/**
 * One round-up: a persistent log of KEF events across however many harness
 * processes it takes. If the process exits (or idles out, or the daemon
 * restarts), the next message starts a new one that resumes the same
 * harness session.
 */
export class Session {
  private row: SessionRow;
  /** Loaded from the store on first use; dropped again once nothing needs it. */
  private log: KelpieEvent[] | undefined;
  /** Live subscribers, each with what to call if the round-up goes away under them. */
  private readonly listeners = new Map<(u: SessionUpdate) => void, (() => void) | undefined>();
  private run: Run | undefined;
  private pumping: Promise<void> = Promise.resolve();
  private pumpActive = false;
  /** Set while a process is being stopped; a message then waits for it and resumes in a new one. */
  private stopping: Promise<void> | undefined;
  /** Set while `launch` gets the harness's directory ready. */
  private starting: Promise<void> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private deleted = false;
  /** Its process was started with settings that have since changed: end it once it is idle. */
  private stale = false;
  /** Permission requests its harness is waiting on, by request id. Only a live process can ask. */
  private readonly asking = new Map<string, EventOf<'permission.requested'>>();
  /** As of the last logged `activity` event, so it never runs ahead of what subscribers have seen. */
  private busyState = false;
  private lastTurnState: TurnStatus | undefined;
  /** For a sub-agent's summary: kept current from its events. */
  private todosState: TodoItem[] = [];
  private nowState: Now = { now: '' };
  private modelState: string | undefined;
  /** A top-level round-up's tickets, read from the store when first asked for. */
  private ticketsState: LinkedTicket[] | undefined;
  /** When the person stopped it with "Stop all", as the store keeps it. */
  private haltedAt: number | undefined;

  constructor(
    row: SessionRow,
    private readonly ctx: SessionContext,
  ) {
    this.row = row;
    this.lastTurnState = ctx.store.lastEvent(row.id, 'turn.ended')?.data.status;
    this.haltedAt = ctx.store.haltOf(row.id);
    if (row.parentId) {
      this.todosState = this.ownTodos();
      this.modelState = ctx.store.lastEvent(row.id, 'session.started')?.data.model;
      // Sub-agent chatter is skipped, so look back a little further than one event.
      for (const e of ctx.store.recentEvents(row.id, ['tool.started', 'message', 'turn.ended'], 20)) {
        const now = nowOf(e);
        if (now) {
          this.nowState = now;
          break;
        }
      }
    }
  }

  get id(): string {
    return this.row.id;
  }

  get cwd(): string {
    return this.row.cwd;
  }

  /** The round-up's scratch folder, shared by its orchestrator and agents; undefined if Kelpie keeps none. */
  get scratch(): string | undefined {
    return this.ctx.scratchDir && join(this.ctx.scratchDir, this.row.parentId ?? this.row.id);
  }

  /** Its harness is being started (its directory readied first). */
  get launching(): boolean {
    return !!this.starting;
  }

  get busy(): boolean {
    return this.busyState;
  }

  /**
   * Busy, or about to be: also true from the moment a turn is sent, before the harness's
   * `activity` event is logged. What scheduling decisions (caps, the writer guard) go by.
   */
  get working(): boolean {
    return this.busyState || (!!this.run && !this.run.exited && this.run.busy);
  }

  get title(): string {
    return this.row.title;
  }

  get harness(): string {
    return this.row.harness;
  }

  /** Epoch ms. */
  get createdAt(): number {
    return this.row.createdAt;
  }

  /** Paused because its harness hit the usage limit, if it is. */
  get limited(): UsageLimitPause | undefined {
    return this.ctx.limits.pause(this.id);
  }

  /** When the person stopped it with "Stop all" (epoch ms), if they did and have not resumed it since. */
  get halted(): number | undefined {
    return this.haltedAt;
  }

  /** Marks it stopped by the person (kept across restarts, which never resume it), or not any more. */
  setHalted(at: number | undefined): void {
    if (this.haltedAt === at || (at !== undefined && this.haltedAt !== undefined)) return;
    if (at === undefined) this.ctx.store.clearHalt(this.id);
    this.haltedAt = at === undefined ? undefined : this.ctx.store.setHalt(this.id, at);
    this.ctx.changed(this);
    this.ctx.agentChanged(this);
  }

  get parentId(): string | undefined {
    return this.row.parentId ?? undefined;
  }

  get role(): 'orchestrator' | 'agent' {
    return this.row.role;
  }

  get kind(): 'worker' | 'muster' {
    return this.row.kind;
  }

  /** An orchestrator's base branch (e.g. `origin/main`) and the commit it is pinned to, once chosen. */
  get baseBranch(): string | undefined {
    return this.row.baseBranch ?? undefined;
  }

  get baseCommit(): string | undefined {
    return this.row.baseCommit ?? undefined;
  }

  setBase(branch: string, commit: string): void {
    this.update({ baseBranch: branch, baseCommit: commit });
  }

  /** The top-level round-up it belongs to: its own id, or its orchestrator's. */
  get roundUpId(): string {
    return this.row.parentId ?? this.row.id;
  }

  /** What its harness is waiting on the person for. */
  approvals(): PendingApproval[] {
    return [...this.asking.values()].map(({ ts, data }) => ({ roundUpId: this.roundUpId, sessionId: this.id, agentTitle: this.row.title, ...data, ts }));
  }

  /** One request still waiting, if it is. */
  approval(requestId: string): PendingApproval | undefined {
    return this.approvals().find((a) => a.requestId === requestId);
  }

  /** Answers a permission request its harness is waiting on; false if it is no longer waiting. */
  answer(requestId: string, answer: PermissionAnswer): boolean {
    if (!this.asking.has(requestId) || !this.run || this.run.exited) return false;
    return this.run.answer(requestId, answer);
  }

  /** The round-up's mode: its own, or for a sub-agent its orchestrator's. */
  get mode(): Mode {
    const parent = this.row.parentId ? this.ctx.get(this.row.parentId) : undefined;
    return parent ? parent.mode : this.row.mode;
  }

  /** Records a top-level round-up's mode (see SessionManager.setMode for what else follows). */
  saveMode(mode: Mode): void {
    this.update({ mode });
  }

  /** Switches the running harness process, if any, to a harness permission mode. */
  async switchMode(harnessMode: string): Promise<boolean> {
    return this.run && !this.run.exited ? this.run.setMode(harnessMode) : false;
  }

  /**
   * Its process's settings (tools, system prompt) are out of date: it is ended now if idle, or as
   * soon as it goes idle, and the next turn resumes the same conversation with fresh ones.
   */
  restartWhenIdle(): void {
    if (!this.run || this.run.exited) return;
    if (this.working) this.stale = true;
    else void this.stop();
  }

  get writes(): boolean {
    return this.row.writes;
  }

  get browser(): boolean {
    return this.row.browser;
  }

  get resumePending(): boolean {
    return this.row.resumePending;
  }

  get notifiedIdx(): number {
    return this.row.notifiedIdx;
  }

  get lastTurn(): TurnStatus | undefined {
    return this.lastTurnState;
  }

  info(): SessionInfo {
    const { id, title, cwd, createdAt, updatedAt, harnessSessionId, harness, parentId, role, writes, browser, model, kind, baseBranch, baseCommit } = this.row;
    return {
      id,
      title,
      cwd,
      createdAt,
      updatedAt,
      busy: this.busy,
      lastTurn: this.lastTurnState,
      harnessSessionId: harnessSessionId ?? undefined,
      harness,
      parentId: parentId ?? undefined,
      role,
      writes,
      browser,
      model: model ?? undefined,
      kind,
      baseBranch: baseBranch ?? undefined,
      baseCommit: baseCommit ?? undefined,
      mode: this.mode,
      tickets: this.tickets(),
      ...(parentId ? this.worktreeSummary() : {}),
      ...(this.limited ? { limited: this.limited } : {}),
      ...(this.haltedAt !== undefined ? { halted: this.haltedAt } : {}),
    };
  }

  /** The Jira and Asana tickets linked to this round-up; a sub-agent has none of its own. */
  tickets(): LinkedTicket[] {
    if (this.row.parentId) return [];
    return (this.ticketsState ??= this.ctx.store.ticketsOf(this.id).map(ticketOf));
  }

  /**
   * Links tickets to this round-up (each once; see Store.linkTicket), titled `title` or the text
   * each was linked with. True, and watchers hear, if anything changed.
   */
  linkTickets(links: TicketLink[], source: TicketSource, title?: string): boolean {
    if (this.row.parentId) throw new Error('tickets are linked to a round-up, not to one of its agents');
    let changed = false;
    for (const t of links) changed = this.ctx.store.linkTicket(this.id, t, source, title) || changed;
    if (changed) this.ticketsChanged();
    return changed;
  }

  /**
   * Titles a linked ticket by its `ref` (no title clears it), unless it has a title from a stronger
   * source (see titleWins). Undefined if it is not linked; true, and watchers hear, if it changed.
   */
  titleTicket(ref: string, title: string | undefined, titleSource: TicketTitleSource): boolean | undefined {
    if (this.row.parentId) return undefined;
    const changed = this.ctx.store.titleTicket(this.id, ref, title, titleSource);
    if (changed) this.ticketsChanged();
    return changed;
  }

  /** Unlinks a ticket by its `ref`; false if it was not linked. */
  unlinkTicket(ref: string): boolean {
    const gone = !this.row.parentId && this.ctx.store.unlinkTicket(this.id, ref);
    if (gone) this.ticketsChanged();
    return gone;
  }

  private ticketsChanged(): void {
    this.ticketsState = undefined;
    this.ctx.changed(this);
  }

  /** A sub-agent at a glance (see AgentSummary). */
  summary(): AgentSummary {
    const { id, title, harness, writes, browser, createdAt, updatedAt } = this.row;
    const t = this.lastTurnState;
    const limited = this.limited;
    return {
      id,
      parentId: this.row.parentId ?? '',
      title,
      harness,
      model: this.modelState ?? this.row.model ?? undefined,
      writes,
      browser,
      status: this.working
        ? this.asking.size
          ? 'needs-approval'
          : 'working'
        : this.haltedAt !== undefined
          ? 'halted'
          : limited
            ? 'paused'
            : t === 'completed'
              ? 'done'
              : t === 'failed'
                ? 'failed'
                : t === 'interrupted'
                  ? 'stopped'
                  : 'idle',
      ...(limited ? { limited } : {}),
      ...(!this.working && this.row.resumePending ? { queued: true } : {}),
      ...this.nowState,
      todos: this.todosState,
      kind: this.row.kind,
      ...this.worktreeSummary(),
      createdAt,
      updatedAt,
    };
  }

  private worktreeSummary(): Pick<AgentSummary, 'branch' | 'deliver' | 'worktree'> {
    const wt = this.ctx.store.worktreeOf(this.id);
    return wt ? { branch: wt.branch, worktree: wt.state, ...(wt.deliver ? { deliver: wt.deliver } : {}) } : {};
  }

  /**
   * What the person allowed for a sub-agent's whole round-up. Never the Claude in Chrome tools, even
   * by a rule saved before Kelpie stopped offering them: every use of the person's browser is asked about.
   */
  private savedRules(): string[] {
    if (!this.row.parentId) return [];
    return this.ctx.store
      .rulesOf(this.row.parentId)
      .map((r) => r.rule)
      .filter((r) => !isChromeTool(r));
  }

  /**
   * Keeps track of what the harness is asking, and answers what the round-up's saved rules or the
   * hooks' policy settle; the rest waits for the person.
   */
  private permissions(run: Run, event: KelpieEvent): void {
    if (event.kind === 'permission.requested') {
      this.asking.set(event.data.requestId, event);
      let auto: PermissionAnswer | undefined;
      try {
        const rule = event.data.rule;
        const saved = !!rule && this.savedRules().includes(rule);
        auto = saved ? { allow: true, by: 'kelpie' } : this.ctx.hooks.decide?.(this, event.data);
      } catch (err) {
        console.error(`session ${this.id}: permission policy failed`, err);
      }
      // Answered at once, it never reaches the person (its resolved event follows on the stream).
      if (auto && run.answer(event.data.requestId, auto)) return;
      this.ctx.approvalsChanged(this);
    } else if (event.kind === 'permission.resolved') {
      if (this.asking.delete(event.data.requestId)) this.ctx.approvalsChanged(this);
    } else if (event.kind === 'process.exited' && this.asking.size) {
      this.asking.clear();
      this.ctx.approvalsChanged(this);
    }
  }

  /** Its latest todo list, as track() keeps it: not one a sub-agent of its own wrote. */
  private ownTodos(): TodoItem[] {
    const own = this.ctx.store.recentEvents(this.id, ['todos'], 200).find((e) => !e.parentCallId);
    return own?.kind === 'todos' ? own.data.items : [];
  }

  /**
   * The harness's latest todo list, whoever changed it last (it keeps one per session, its
   * sub-agents' tasks included): what its last process ended with, so a resumed one starts from it.
   */
  private sessionTodos(): TodoItem[] {
    return this.ctx.store.lastEvent(this.id, 'todos')?.data.items ?? [];
  }

  /** Folds an event into a sub-agent's summary; true if the pane should hear about it. */
  private track(event: KelpieEvent): boolean {
    if (!this.row.parentId || !SUMMARY_KINDS.has(event.kind)) return false;
    if (event.kind === 'todos' && !event.parentCallId) this.todosState = event.data.items;
    if (event.kind === 'session.started') this.modelState = event.data.model;
    this.nowState = nowOf(event) ?? this.nowState;
    return true;
  }

  /** The whole log, without keeping it in memory for longer than needed. */
  events(): KelpieEvent[] {
    const log = this.load().slice();
    this.release();
    return log;
  }

  /**
   * Closes out a run the daemon never saw finish (it was killed mid-run), so
   * the log does not end mid-turn with tools forever running.
   */
  repair(): void {
    const { store } = this.ctx;
    // Kelpie's own entries (a halt) are not the run's: what the run last logged says whether it ended.
    const last = store.lastRunEvent(this.id);
    if (!last || last.kind === 'process.exited') return;
    const busy = store.lastEvent(this.id, 'activity')?.data.busy ?? false;
    let seq = last.seq;
    const ts = new Date().toISOString();
    const close = <K extends EventKind>(kind: K, data: EventData<K>) =>
      ({ id: randomUUID(), runId: last.runId, seq: ++seq, ts, harness: last.harness, kind, data }) as KelpieEvent;
    // Requests the dead process was still asking: nobody can answer them now (the resumed agent asks again).
    const asked = store.recentEvents(this.id, ['permission.requested', 'permission.resolved'], 500).reverse();
    const open = new Set<string>();
    for (const e of asked) {
      if (e.kind === 'permission.requested') open.add(e.data.requestId);
      else if (e.kind === 'permission.resolved') open.delete(e.data.requestId);
    }
    const closing = [...open].map((requestId) => close('permission.resolved', { requestId, decision: 'deny', by: 'expired' }));
    if (busy) closing.push(close('turn.ended', { status: 'interrupted', error: STOPPED }), close('activity', { busy: false }));
    closing.push(close('process.exited', { code: null, signal: null, stderrTail: STOPPED }));
    let idx = store.eventCount(this.id);
    // Keep the round-up's place in the list: this is housekeeping, not activity.
    store.atomically(() => {
      for (const e of closing) {
        store.appendEvent(this.id, idx++, e, this.row.updatedAt);
        // The summary was read from the log before these were added.
        this.track(e);
      }
      // It was cut off mid-work: the next daemon start resumes it.
      if (busy) this.row = store.updateSession(this.id, { resumePending: true }) ?? this.row;
    });
    if (busy) this.lastTurnState = 'interrupted';
  }

  /**
   * Sends a turn. It is written to the outbox first, so a turn the harness has not taken in
   * yet survives a crash and is sent again.
   */
  async send(text: string, source: OutboxSource = 'user', opts: SendOptions = {}): Promise<void> {
    const together = opts.together ?? [];
    const all: Session[] = [this, ...together.map((t) => t.session)];
    // A process can exit before its last events are logged; logging its exit clears the outbox, so a turn waits.
    // For several sessions, until none of them is in that state at once.
    do {
      await Promise.all(all.map((s) => s.settled()));
    } while (all.some((s) => s.unsettled()));
    for (const s of all) if (s.deleted) throw new Error(s === this ? 'this round-up was deleted' : `"${s.title}" was deleted`);
    if (this.ctx.closing) throw new Error('Kelpie is shutting down');
    const files = opts.attachments ?? [];
    const found = source === 'user' ? findTickets(text) : [];
    // An orchestrator hears which tickets it links without a name, to title them once it knows them.
    const known = found.length && this.role === 'orchestrator' && !this.row.parentId ? new Map(this.tickets().map((t) => [t.ref, t])) : undefined;
    const unnamed = known ? found.filter((t) => !t.title && !known.get(t.ref)?.title).map((t) => t.url) : [];
    const body = unnamed.length ? `${text}\n\n${ticketsNote(unnamed)}` : text;
    // The paths are in the text itself, so a turn re-sent after a crash still carries its files.
    const turn = files.length ? `${body.trim() ? `${body}\n\n` : ''}${attachmentsBlock(files)}` : body;
    // The harness echoes an empty turn as nothing, which would put the outbox out of step.
    if (!turn.trim() || together.some((t) => !t.text.trim())) throw new Error('a turn needs some text');
    const meta = files.length ? { ...opts.meta, attachments: files.map(({ path: _, ...a }) => a) } : opts.meta;
    for (const s of all) s.load();
    let sent = turn;
    this.ctx.store.atomically(() => {
      opts.alsoInTx?.();
      const extra = [source === 'user' ? undefined : this.ctx.hooks.inbox?.(this), this.ctx.hooks.notice?.(this)].filter(Boolean);
      if (extra.length) sent = [turn, ...extra].join('\n\n');
      this.ctx.store.enqueue(this.id, sent, source, Date.now(), meta);
      for (const t of together) this.ctx.store.enqueue(t.session.id, t.text, t.source, Date.now(), t.meta);
    });
    if (!this.row.title && source === 'user') this.update({ title: titleFrom(text) || titleFrom(files.map((f) => f.name).join(', ')) });
    if (source === 'user') {
      try {
        this.ctx.hooks.personSent?.(this);
      } catch (err) {
        console.error(`session ${this.id}: hook failed`, err);
      }
    }
    // Tickets the person links to, in their round-up or to one of its agents, are the round-up's.
    if (found.length) {
      try {
        (this.row.parentId ? this.ctx.get(this.row.parentId) : this)?.linkTickets(found, 'auto');
      } catch (err) {
        console.error(`session ${this.id}: could not link tickets`, err);
      }
    }
    // Each is in its outbox now: one that cannot start here is sent on the next start.
    const dispatched = await Promise.allSettled([this.dispatch(sent), ...together.map((t) => t.session.dispatch(t.text))]);
    dispatched.slice(1).forEach((r, i) => r.status === 'rejected' && console.error(`session ${together[i]!.session.id}: could not start`, r.reason));
    if (dispatched[0]!.status === 'rejected') throw dispatched[0]!.reason;
  }

  /** Waits until a turn can be queued without its process's exit clearing it. */
  private async settled(): Promise<void> {
    while (this.stopping) await this.stopping;
    if (this.run?.exited) await this.pumping;
  }

  private unsettled(): boolean {
    return !!this.stopping || (!!this.run?.exited && this.pumpActive);
  }

  /** Hands a queued turn to the live process, or starts one (which sends every undelivered turn). */
  private async dispatch(turn: string): Promise<void> {
    if (this.run && !this.run.exited) this.run.send(turn);
    else await this.launch();
  }

  /**
   * Picks up after Kelpie stopped mid-work: re-sends the turns the harness never took in,
   * or, if there are none, `note` (asking it to carry on). Clears `resumePending` once the
   * turns are on their way: from then on the outbox (and `repair()`) carry it across a crash.
   */
  async resumeAfterRestart(note: string): Promise<void> {
    while (this.stopping) await this.stopping;
    if (this.run?.exited) await this.pumping;
    if (this.deleted || this.ctx.closing) return;
    if (!this.run || this.run.exited) {
      if (this.ctx.store.undelivered(this.id).length) await this.launch();
      else await this.send(note, 'kelpie');
    }
    this.clearResumePending();
  }

  /**
   * Picks up after the usage limit reset: sends `note` (with any turn the harness never took in),
   * to its live process or a new one that resumes the same harness session.
   */
  async resumeAfterLimit(note: string = LIMIT_RESUMED): Promise<void> {
    if (this.deleted || this.ctx.closing) return;
    await this.send(note, 'kelpie', { meta: { resumed: 'limit' } });
    this.clearResumePending();
  }

  /** Picks up after the person stopped it ("Stop all") and resumed it: sends `note`, to its live process or a new one. */
  async resumeAfterHalt(note: string): Promise<void> {
    if (this.deleted || this.ctx.closing) return;
    await this.send(note, 'kelpie', { meta: { resumed: 'halt' } });
    this.clearResumePending();
  }

  markResumePending(): void {
    this.update({ resumePending: true });
  }

  /** Something else (e.g. a new message) has picked this round-up up again. */
  clearResumePending(): void {
    if (this.row.resumePending) this.update({ resumePending: false });
  }

  /** Something about a sub-agent outside its log changed (e.g. its branch was mustered): the pane and the round-up's dot hear. */
  summaryChanged(): void {
    if (!this.row.parentId) return;
    this.ctx.agentChanged(this);
    this.ctx.changed(this);
  }

  /**
   * Logs an entry of Kelpie's own (not the harness's) and shows it to watchers: e.g. that the person
   * stopped all agents. It moves the round-up up the list, as anything the person does.
   */
  note<K extends EventKind>(kind: K, data: EventData<K>): void {
    if (this.deleted) return;
    const log = this.load();
    const event = { id: randomUUID(), runId: 'kelpie', seq: 0, ts: new Date().toISOString(), harness: this.row.harness, kind, data } as KelpieEvent;
    const index = log.push(event) - 1;
    const now = Date.now();
    try {
      this.ctx.store.appendEvent(this.id, index, event, now);
      this.row = { ...this.row, updatedAt: now };
    } catch (err) {
      console.error(`session ${this.id}: could not store event ${index}`, err);
    }
    this.emit(index, event);
    this.release();
    this.ctx.changed(this);
  }

  /** Hands a logged event to every subscriber: one broken one must neither starve the others nor take the daemon down. */
  private emit(index: number, event: KelpieEvent): void {
    for (const listener of this.listeners.keys()) {
      try {
        listener({ index, event });
      } catch (err) {
        console.error(`session ${this.id}: listener failed`, err);
      }
    }
  }

  /** Records that the orchestrator has been told about this sub-agent up to log index `index`. */
  markNotified(index: number): void {
    this.row = this.ctx.store.updateSession(this.id, { notifiedIdx: index }) ?? this.row;
  }

  /**
   * Gets what the harness runs in ready (a swept worktree is recreated), then starts it. One at
   * a time: a turn sent meanwhile is in the outbox, and `start` sends every undelivered turn.
   */
  private launch(): Promise<void> {
    this.starting ??= (async () => {
      try {
        await this.ctx.hooks.prepare?.(this);
        // The last process may have exited with events still buffered: `start` reads what they leave (its todo list).
        await this.pumping;
      } finally {
        this.starting = undefined;
      }
      if (!this.deleted && !this.ctx.closing && (!this.run || this.run.exited)) this.start();
    })();
    return this.starting;
  }

  /** Starts a harness process with every turn still undelivered, oldest first. */
  private start(): void {
    const { store, hooks } = this.ctx;
    const texts = store.undelivered(this.id).map((r) => r.text);
    if (!texts.length) return;
    // The harness is given the scratch folder (--add-dir), so it must exist.
    if (this.scratch) mkdirSync(this.scratch, { recursive: true });
    const runId = randomUUID();
    const resume = this.row.harnessSessionId ?? undefined;
    const hadHistory = store.firstSent(this.id)?.deliveredAt != null;
    this.stale = false;
    const hooked = hooks.specFor?.(this, { runId, fresh: !resume, hadHistory });
    const spec: Partial<RunSpec> = {
      ...this.ctx.defaults,
      permissionMode: this.mode,
      ...(this.row.model ? { model: this.row.model } : {}),
      ...hooked,
      // A hook's env (a connection's GH_TOKEN) adds to the defaults' rather than replacing them.
      ...(hooked?.env ? { env: { ...this.ctx.defaults.env, ...hooked.env } } : {}),
    };
    // What the person allowed for the whole round-up, its agents may do without asking.
    const saved = this.savedRules();
    if (saved.length) spec.allowedTools = [...(spec.allowedTools ?? []), ...saved];
    const run = this.ctx.adapter.start({
      ...spec,
      cwd: this.cwd,
      prompt: texts[0]!,
      runId,
      ...(this.ctx.runsDir ? { runDir: join(this.ctx.runsDir, runId) } : {}),
      // The harness keeps its todo list across a resume, but this new process has not seen it.
      ...(resume ? { resume, todos: this.sessionTodos() } : {}),
    });
    for (const text of texts.slice(1)) run.send(text);
    this.run = run;
    this.pumping = this.pump(run, resume);
  }

  /** Stops the current turn; one paused at the usage limit is no longer resumed on its own either. */
  async interrupt(): Promise<void> {
    this.ctx.cancelLimits(this);
    // Still starting: its turn is on its way, so it is stopped once its process is up.
    if (this.starting) await this.starting.catch(() => {});
    await this.run?.interrupt();
  }

  rename(title: string): void {
    this.update({ title });
  }

  /**
   * The model for its next process; undefined goes back to the default. An idle process is
   * ended now so the next turn starts on it (resuming the same conversation); a busy one
   * keeps its model until it ends.
   */
  setModel(model: string | undefined): void {
    this.update({ model: model ?? null });
    if (!this.working) void this.stop();
  }

  /** Ends the harness process, if any, once its last events are logged. */
  async stop(): Promise<void> {
    clearTimeout(this.idleTimer);
    const run = this.run;
    if (!run) return;
    const stopping = (this.stopping = Promise.all([run.stop(), this.pumping]).then(() => {}));
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = undefined;
    }
  }

  async delete(): Promise<void> {
    this.deleted = true;
    await this.stop();
    const closers = [...this.listeners.values()];
    this.listeners.clear();
    this.ctx.store.deleteSession(this.id);
    closers.forEach((close) => close?.());
  }

  /**
   * Replays the log from `fromIndex`, then streams live updates until
   * unsubscribed. `onClosed` runs if the round-up is deleted meanwhile.
   */
  subscribe(listener: (u: SessionUpdate) => void, fromIndex = 0, onClosed?: () => void): () => void {
    const log = this.load();
    for (let i = Math.max(0, fromIndex); i < log.length; i++) listener({ index: i, event: log[i]! });
    this.listeners.set(listener, onClosed);
    return () => {
      this.listeners.delete(listener);
      this.release();
    };
  }

  private load(): KelpieEvent[] {
    return (this.log ??= this.ctx.store.loadEvents(this.id));
  }

  /** Lets the log go once no one is watching and no run is writing to it; the store has it all. */
  private release(): void {
    if (!this.listeners.size && !this.pumpActive) this.log = undefined;
  }

  private update(patch: SessionPatch): void {
    this.row = this.ctx.store.updateSession(this.id, patch) ?? this.row;
    this.ctx.changed(this);
  }

  /** Stops a process left idle; the next message resumes the session in a new one. */
  private armIdle(run: Run): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void (!run.busy && !run.exited && this.stop()), this.ctx.idleMs);
    this.idleTimer.unref();
  }

  /**
   * A run's events, then, if it could not resume (`failed`), an empty todo list: the old list
   * went with the session, and the fresh one starts without any. The pane shows that, and a
   * later resume of the fresh session is not handed the old tasks.
   */
  private async *withReset(run: Run, failed: () => boolean): AsyncGenerator<KelpieEvent> {
    for await (const event of run.events) {
      yield event;
      if (event.kind !== 'process.exited' || !failed() || (!this.sessionTodos().length && !this.ownTodos().length)) continue;
      yield { id: randomUUID(), runId: event.runId, seq: event.seq + 1, ts: event.ts, harness: event.harness, kind: 'todos', data: { items: [] } } as KelpieEvent;
    }
  }

  private async pump(run: Run, resumed: string | undefined): Promise<void> {
    const log = this.load();
    let started = false;
    let retryFresh = false;
    this.pumpActive = true;
    try {
      for await (let event of this.withReset(run, () => retryFresh)) {
        if (this.deleted) continue; // drain the process, log nothing
        let changed = false;
        if (event.kind === 'session.started') {
          started = true;
          if (event.data.harnessSessionId !== this.row.harnessSessionId) this.update({ harnessSessionId: event.data.harnessSessionId });
        } else if (event.kind === 'activity') {
          this.busyState = event.data.busy;
          if (event.data.busy) clearTimeout(this.idleTimer);
          else if (this.stale) void this.stop();
          else this.armIdle(run);
          changed = true;
        } else if (event.kind === 'rate_limit') {
          this.ctx.reportUsage(event.harness, event.data);
        } else if (event.kind === 'turn.ended') {
          // Stopped at the usage limit: paused until it resets, and its log entry says when Kelpie picks it up.
          const stop = this.ctx.adapter.limitOf?.(event);
          if (stop) event = { ...event, data: { ...event.data, limit: this.ctx.limits.hit(this, stop, event.data.limit) } };
          this.lastTurnState = event.data.status;
          changed = true;
        } else if (event.kind === 'process.exited') {
          clearTimeout(this.idleTimer);
          // The harness could not resume (e.g. its transcript is gone): start afresh, re-sending
          // whatever it never took in.
          if (resumed && !started && event.data.code) {
            this.update({ harnessSessionId: null });
            retryFresh = true;
          }
        }

        // The harness echoing a sent turn: the oldest outbox row is delivered, and says who sent it.
        let deliveredId: number | undefined;
        if (event.kind === 'message' && event.data.sent) {
          const row = this.ctx.store.undelivered(this.id)[0];
          if (row) {
            deliveredId = row.id;
            event = { ...event, data: { ...event.data, ...(row.meta ? JSON.parse(row.meta) : {}), source: row.source } };
          }
        }

        const index = log.push(event) - 1;
        // A process ending (idle timeout, daemon shutdown) is housekeeping: it must not reorder the list.
        // So is anything logged after a failed resume.
        const now = event.kind === 'process.exited' || retryFresh ? this.row.updatedAt : Date.now();
        try {
          this.ctx.store.appendEvent(this.id, index, event, now, deliveredId);
          this.row = { ...this.row, updatedAt: now };
          // Turns this process never read are dropped, not retried forever: the turn that
          // failed shows in the log, and whoever sent it can send again. Kept only when Kelpie
          // itself is stopping (the next start re-sends them) or a fresh start will retry them once.
          if (event.kind === 'process.exited' && !retryFresh && !this.ctx.closing) this.ctx.store.discardUndelivered(this.id);
        } catch (err) {
          console.error(`session ${this.id}: could not store event ${index}`, err);
        }
        this.emit(index, event);
        if (changed) this.ctx.changed(this);
        this.ctx.limits.observe(this, event);
        this.permissions(run, event);
        if (this.track(event)) this.ctx.agentChanged(this);
        try {
          this.ctx.hooks.observe?.(this, index, event);
        } catch (err) {
          console.error(`session ${this.id}: observer failed`, err);
        }
      }
    } catch (err) {
      console.error(`session ${this.id}: event stream failed`, err);
    } finally {
      this.pumpActive = false;
      this.release();
    }
    if (retryFresh && !this.deleted && !this.ctx.closing && this.run === run) {
      this.launch().catch((err) => console.error(`session ${this.id}: could not restart`, err));
    }
  }
}

export class SessionManager {
  readonly defaultCwd: string;
  private readonly store: Store;
  private readonly sessions = new Map<string, Session>();
  private readonly watchers = new Set<(u: ManagerUpdate) => void>();
  private readonly ctx: SessionContext;
  /** Each harness's usage, served from memory; the store only keeps it across restarts. */
  private readonly usageByHarness = new Map<string, HarnessUsage>();
  /** Sub-agents whose summary changed and is about to go out. */
  private readonly agentTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Sessions paused at the usage limit, and when each resumes (see `startLimits`). */
  readonly limits: UsageLimits;

  constructor(opts: SessionManagerOptions) {
    this.store = opts.store;
    this.defaultCwd = opts.defaultCwd;
    this.ctx = {
      store: opts.store,
      defaults: opts.defaults ?? {},
      adapter: opts.adapter ?? claudeCode,
      runsDir: opts.runsDir,
      // Real path: the harness matches its permission rules against resolved paths (/tmp is /private/tmp on macOS).
      scratchDir: opts.scratchDir && (mkdirSync(opts.scratchDir, { recursive: true }), realpathSync(opts.scratchDir)),
      idleMs: opts.idleMs ?? 10 * 60_000,
      hooks: opts.hooks ?? {},
      closing: false,
      changed: (s) => this.publish({ type: 'session', session: s.info() }),
      get: (id) => this.sessions.get(id),
      approvalsChanged: (s) => this.publish({ type: 'approvals', roundUpId: s.roundUpId, approvals: this.approvals(s.roundUpId) }),
      // A busy agent emits many events a second; the pane only needs a few updates.
      agentChanged: (s) => {
        if (this.agentTimers.has(s.id)) return;
        const timer = setTimeout(() => {
          this.agentTimers.delete(s.id);
          // Nobody listening, nothing to build (the summary reads the store).
          if (this.watchers.size && this.sessions.get(s.id) === s) this.publish({ type: 'agent', agent: s.summary() });
        }, AGENT_UPDATE_MS);
        timer.unref();
        this.agentTimers.set(s.id, timer);
      },
      // Usage is advisory: nothing about it may disturb the run that reported it.
      reportUsage: (harness, report) => {
        const now = Date.now();
        const usage = mergeUsage(this.usageByHarness.get(harness)?.usage, report);
        this.usageByHarness.set(harness, { harness: harness as HarnessUsage['harness'], usage, updatedAt: now });
        try {
          this.store.setUsage(harness, usage, now);
        } catch (err) {
          console.error(`could not store ${harness} usage`, err);
        }
        this.publish({ type: 'usage', usage: this.usage() });
      },
      limits: undefined as unknown as UsageLimits,
      cancelLimits: (s) => this.cancelLimits(s.id),
    };
    const hooks = this.ctx.hooks;
    this.limits = this.ctx.limits = new UsageLimits({
      store: this.store,
      get: (id) => this.sessions.get(id),
      resume: async (id) => {
        const s = this.sessions.get(id);
        if (!s) return;
        await (hooks.resumeLimited ? hooks.resumeLimited(s) : s.resumeAfterLimit());
      },
      enabled: () => hooks.autoResume?.() ?? true,
      ...(opts.limitTiming ? { timing: opts.limitTiming } : {}),
      changed: (id) => {
        const s = this.sessions.get(id);
        if (!s) return;
        this.ctx.changed(s);
        this.ctx.agentChanged(s);
        try {
          hooks.limitChanged?.(s);
        } catch (err) {
          console.error(`session ${id}: limit hook failed`, err);
        }
      },
    });
    for (const u of this.store.listUsage()) this.usageByHarness.set(u.harness, u);
    for (const row of this.store.listSessions()) {
      const session = new Session(row, this.ctx);
      session.repair();
      this.sessions.set(session.id, session);
    }
  }

  create(cwd = this.defaultCwd, opts: CreateOptions = {}): Session {
    const model = opts.model ?? this.ctx.defaults.model;
    const row = this.store.createSession({
      id: opts.id ?? randomUUID(),
      cwd,
      ...(model ? { model } : {}),
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.baseBranch ? { baseBranch: opts.baseBranch, baseCommit: opts.baseCommit ?? null } : {}),
      ...(opts.role ? { role: opts.role } : {}),
      ...(opts.writes ? { writes: true } : {}),
      ...(opts.browser ? { browser: true } : {}),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
    });
    const session = new Session(row, this.ctx);
    this.sessions.set(session.id, session);
    this.publish({ type: 'session', session: session.info() });
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Top-level round-ups, most recently active first. */
  list(): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((s) => !s.parentId)
      .map((s) => s.info())
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }

  /** Every round-up, sub-agents included. */
  all(): Session[] {
    return [...this.sessions.values()];
  }

  /** An orchestrator's sub-agents, oldest first. */
  children(parentId: string): Session[] {
    return this.all()
      .filter((s) => s.parentId === parentId)
      .sort((a, b) => a.info().createdAt - b.info().createdAt);
  }

  /** Deletes a round-up and, first, its sub-agents (stopping their processes). */
  /** Deletes a round-up and its sub-agents, or one sub-agent. `withParent`: its orchestrator is going too. */
  async delete(id: string, withParent = false): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (!withParent) {
      // Nothing may still be writing when its worktrees are cleaned up, and their rows go with it.
      await Promise.all([session, ...this.children(id)].map((s) => s.stop()));
      await this.ctx.hooks.removing?.(session).catch((err) => console.error(`round-up ${id}: worktree cleanup failed`, err));
    }
    this.sessions.delete(id);
    this.limits.forget(id);
    await Promise.all(this.children(id).map((c) => this.delete(c.id, true)));
    await session.delete();
    // A round-up's scratch folder goes with it; a sub-agent's files stay for the rest of the round-up.
    if (!session.parentId && session.scratch) {
      await rm(session.scratch, { recursive: true, force: true }).catch((err) => console.error(`round-up ${id}: could not remove its scratch folder`, err));
    }
    this.publish({ type: 'deleted', id });
    return true;
  }

  /** Saves a file the person uploaded into the round-up's scratch folder. */
  async saveUpload(session: Session, file: { name: string; mime: string; bytes: Uint8Array }): Promise<AttachmentRow> {
    const scratch = session.scratch;
    if (!scratch) throw new Error('uploads need a scratch folder, and Kelpie was started without one');
    const roundUpId = session.parentId ?? session.id;
    const gone = () => !this.sessions.has(roundUpId);
    if (gone()) throw new Error('this round-up was deleted');
    const id = randomUUID();
    const dir = join(scratch, 'uploads');
    // The id prefix keeps two uploads of the same name apart.
    const path = join(dir, `${id.slice(0, 8)}-${safeName(file.name)}`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(path, file.bytes, { flag: 'wx' });
      return this.store.addAttachment({ id, roundUpId, name: file.name, mime: file.mime, size: file.bytes.length, path });
    } catch (err) {
      // Deleted while the file was written: its scratch folder was removed already, and must not come back.
      await rm(gone() ? scratch : path, { recursive: true, force: true }).catch(() => {});
      throw gone() ? new Error('this round-up was deleted') : err;
    }
  }

  /** Uploads of the round-up `session` belongs to, in the order asked; unknown ids are left out. */
  uploads(session: Session, ids: string[]): AttachmentRow[] {
    return this.store.attachmentsOf(session.parentId ?? session.id, ids);
  }

  /** What round-ups are waiting on the person for (one round-up's, or every one's), oldest first. */
  approvals(roundUpId?: string): PendingApproval[] {
    return [...this.sessions.values()]
      .filter((s) => !roundUpId || s.roundUpId === roundUpId)
      .flatMap((s) => s.approvals())
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }

  /**
   * The person's answer to a batch of approvals. Each is answered on its own: one already answered
   * or gone is reported, and the rest still go through. `remember` saves each one's rule for its
   * round-up, so its agents are no longer asked (and others asking the same now are answered too).
   * `mode`, for a plan, takes the round-up out of plan mode as the plan is approved. Questions are
   * allowed with `answers` (one at a time); denying them is the person skipping them.
   */
  async answerApprovals(opts: {
    items: { sessionId: string; requestId: string }[];
    allow: boolean;
    message?: string;
    remember?: boolean;
    mode?: Mode;
    answers?: Answers;
  }): Promise<ApprovalResult[]> {
    const results: ApprovalResult[] = [];
    const saved = new Map<string, Set<string>>();
    for (const { sessionId, requestId } of opts.items) {
      const session = this.sessions.get(sessionId);
      const pending = session?.approval(requestId);
      if (!session || !pending) {
        results.push({ sessionId, requestId, ok: false, error: 'no longer waiting: answered already, or its run ended' });
        continue;
      }
      if (opts.allow && pending.tool === 'ExitPlanMode') {
        // Approving a plan ends plan mode: without a mode to go to, the orchestrator would be told to
        // carry the plan out and then be refused every writer.
        if (!opts.mode) {
          results.push({ sessionId, requestId, ok: false, error: 'approving a plan needs the mode to carry it out in (auto or acceptEdits)' });
          continue;
        }
        const roundUp = this.sessions.get(session.roundUpId);
        if (roundUp) await this.setMode(roundUp, opts.mode);
      }
      if (opts.answers && !pending.questions) {
        results.push({ sessionId, requestId, ok: false, error: 'answers are for questions, and this is not a question' });
        continue;
      }
      // Questions take their answers: a bare yes would tell the agent the person said nothing.
      const answers = pending.questions && opts.allow ? opts.answers : undefined;
      if (pending.questions && opts.allow) {
        const error = answers ? answersError(pending.questions, answers) : 'answering questions needs the answers';
        if (error) {
          results.push({ sessionId, requestId, ok: false, error });
          continue;
        }
      }
      const rule = opts.allow && opts.remember && session.parentId && pending.rule && !isChromeTool(pending.rule) ? pending.rule : undefined;
      const ok = session.answer(
        requestId,
        opts.allow
          ? { allow: true, by: 'person', ...(rule ? { rules: [rule] } : {}), ...(answers ? { answers } : {}) }
          : { allow: false, by: 'person', message: opts.message?.trim() || (pending.questions ? SKIPPED : DENIED) },
      );
      // Saved only once it went through: a rule for a request nobody was asking any more is not the person's choice.
      if (ok && rule) {
        this.store.addRule(session.roundUpId, rule);
        saved.set(session.roundUpId, (saved.get(session.roundUpId) ?? new Set()).add(rule));
      }
      results.push({ sessionId, requestId, ok, ...(ok ? {} : { error: 'no longer waiting: its run ended' }) });
    }
    // Others in the round-up asking for what was just allowed for all of it.
    for (const [roundUpId, rules] of saved) {
      for (const a of this.approvals(roundUpId)) {
        if (a.rule && rules.has(a.rule) && a.sessionId !== a.roundUpId) this.sessions.get(a.sessionId)?.answer(a.requestId, { allow: true, by: 'kelpie', rules: [a.rule] });
      }
    }
    return results;
  }

  /** The rules the person saved for a round-up. */
  rules(roundUpId: string): { id: number; rule: string; createdAt: number }[] {
    return this.store.rulesOf(roundUpId).map(({ id, rule, createdAt }) => ({ id, rule, createdAt }));
  }

  /** Forgets one saved rule. Agents running now keep it until they next start. */
  deleteRule(roundUpId: string, id: number): boolean {
    return this.store.deleteRule(roundUpId, id);
  }

  /** The modes the harness supports, in the order a person cycles through them. */
  get modes(): readonly Mode[] {
    return this.ctx.adapter.modes;
  }

  /** The harnesses round-ups can run on, and what each offers. */
  harnesses(): { harness: string; modes: readonly Mode[] }[] {
    return [{ harness: this.ctx.adapter.harness, modes: this.ctx.adapter.modes }];
  }

  /**
   * Sets a top-level round-up's mode. Its agents follow it: the hooks bring their live processes
   * in line, and every later start uses it.
   */
  async setMode(session: Session, mode: Mode): Promise<void> {
    if (session.parentId) throw new Error("a sub-agent follows its round-up's mode");
    if (!this.modes.includes(mode)) throw new Error(`${this.ctx.adapter.harness} has no ${mode} mode`);
    if (session.mode === mode) return;
    session.saveMode(mode);
    if (this.ctx.hooks.modeChanged) await this.ctx.hooks.modeChanged(session);
    else await session.switchMode(mode);
  }

  /** Each harness's latest subscription usage. */
  usage(): HarnessUsage[] {
    return [...this.usageByHarness.values()];
  }

  /** Round-up list changes: creations, renames, busy flips, finished turns, deletions; and usage reports. */
  watch(listener: (u: ManagerUpdate) => void): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }

  /**
   * The person's "Don't auto-resume", or an interrupt: the session stays paused until someone sends
   * it a turn. For a paused round-up, its paused agents too: otherwise they would pick up, and their
   * notices wake the orchestrator. False if the session itself was not paused.
   */
  cancelLimits(id: string): boolean {
    const own = this.limits.cancel(id);
    const s = this.sessions.get(id);
    if (own && s && !s.parentId) for (const c of this.children(id)) this.limits.cancel(c.id);
    return own;
  }

  /**
   * Starts resuming sessions paused at the usage limit: what is due goes now, the rest at its time.
   * Call once harnesses can start (after recovery).
   */
  startLimits(): void {
    this.limits.start();
  }

  /** Marks every round-up still working, so the next daemon start resumes it. Call before `stopAll`. */
  prepareShutdown(): void {
    this.ctx.closing = true;
    this.limits.stop();
    for (const s of this.sessions.values()) if (s.working) s.markResumePending();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.stop()));
    // Pane updates still pending are moot once Kelpie stops (and the store may close next).
    this.agentTimers.forEach((t) => clearTimeout(t));
    this.agentTimers.clear();
  }

  /** Sends an update to everyone watching. */
  publish(update: ManagerUpdate): void {
    for (const listener of this.watchers) {
      try {
        listener(update);
      } catch (err) {
        console.error('session list listener failed', err);
      }
    }
  }
}
