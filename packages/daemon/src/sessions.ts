import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mergeUsage, type EventData, type EventKind, type HarnessUsage, type KelpieEvent } from '@kelpie/protocol';
import { claudeCode, type Adapter, type Run, type RunSpec } from '@kelpie/adapters';
import type { OutboxSource, SessionPatch, SessionRow, Store } from '@kelpie/store';

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
}

/** What subscribers receive. `index` is the event's position in the session log (stable across runs and restarts). */
export interface SessionUpdate {
  index: number;
  event: KelpieEvent;
}

/** What the round-up list stream carries. */
export type ManagerUpdate =
  | { type: 'session'; session: SessionInfo }
  | { type: 'deleted'; id: string }
  | { type: 'usage'; usage: HarnessUsage[] };

export type SessionDefaults = Omit<RunSpec, 'cwd' | 'prompt' | 'resume' | 'runId' | 'runDir'>;

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
  specFor?(session: Session, run: RunContext): Partial<RunSpec>;
  /** Every event, once it is logged and subscribers have seen it. Must not throw. */
  observe?(session: Session, index: number, event: KelpieEvent): void;
}

export interface CreateOptions {
  parentId?: string;
  role?: 'orchestrator' | 'agent';
  writes?: boolean;
  title?: string;
  model?: string;
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
}

interface SessionContext {
  store: Store;
  defaults: SessionDefaults;
  adapter: Adapter;
  runsDir: string | undefined;
  idleMs: number;
  hooks: SessionHooks;
  /** Set once the daemon is shutting down: nothing may start a harness process any more. */
  closing: boolean;
  changed: (s: Session) => void;
  reportUsage: (harness: string, usage: EventData<'rate_limit'>) => void;
}

const STOPPED = 'Kelpie stopped while this run was active.';
const TITLE_MAX = 60;

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
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private deleted = false;
  /** As of the last logged `activity` event, so it never runs ahead of what subscribers have seen. */
  private busyState = false;
  private lastTurnState: TurnStatus | undefined;

  constructor(
    row: SessionRow,
    private readonly ctx: SessionContext,
  ) {
    this.row = row;
    this.lastTurnState = ctx.store.lastEvent(row.id, 'turn.ended')?.data.status;
  }

  get id(): string {
    return this.row.id;
  }

  get cwd(): string {
    return this.row.cwd;
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

  get parentId(): string | undefined {
    return this.row.parentId ?? undefined;
  }

  get role(): 'orchestrator' | 'agent' {
    return this.row.role;
  }

  get writes(): boolean {
    return this.row.writes;
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
    const { id, title, cwd, createdAt, updatedAt, harnessSessionId, harness, parentId, role, writes } = this.row;
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
    };
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
    const last = store.lastEvent(this.id);
    if (!last || last.kind === 'process.exited') return;
    const busy = store.lastEvent(this.id, 'activity')?.data.busy ?? false;
    let seq = last.seq;
    const ts = new Date().toISOString();
    const close = <K extends EventKind>(kind: K, data: EventData<K>) =>
      ({ id: randomUUID(), runId: last.runId, seq: ++seq, ts, harness: last.harness, kind, data }) as KelpieEvent;
    const closing = busy
      ? [close('turn.ended', { status: 'interrupted', error: STOPPED }), close('activity', { busy: false })]
      : [];
    closing.push(close('process.exited', { code: null, signal: null, stderrTail: STOPPED }));
    let idx = store.eventCount(this.id);
    // Keep the round-up's place in the list: this is housekeeping, not activity.
    store.atomically(() => {
      for (const e of closing) store.appendEvent(this.id, idx++, e, this.row.updatedAt);
      // It was cut off mid-work: the next daemon start resumes it.
      if (busy) this.row = store.updateSession(this.id, { resumePending: true }) ?? this.row;
    });
    if (busy) this.lastTurnState = 'interrupted';
  }

  /**
   * Sends a turn. It is written to the outbox first, so a turn the harness has not taken in
   * yet survives a crash and is sent again. `alsoInTx` runs in the same transaction as that
   * write (e.g. marking what a notification covers).
   */
  async send(text: string, source: OutboxSource = 'user', alsoInTx?: () => void): Promise<void> {
    while (this.stopping) await this.stopping;
    if (this.deleted) throw new Error('this round-up was deleted');
    if (this.ctx.closing) throw new Error('Kelpie is shutting down');
    // The harness echoes an empty turn as nothing, which would put the outbox out of step.
    if (!text.trim()) throw new Error('a turn needs some text');
    this.load();
    this.ctx.store.atomically(() => {
      alsoInTx?.();
      this.ctx.store.enqueue(this.id, text, source);
    });
    if (this.run && !this.run.exited) this.run.send(text);
    else this.start();
    if (!this.row.title && source === 'user') this.update({ title: titleFrom(text) });
  }

  /**
   * Picks up after Kelpie stopped mid-work: re-sends the turns the harness never took in,
   * or, if there are none, `note` (asking it to carry on). Clears `resumePending` once the
   * turns are on their way: from then on the outbox (and `repair()`) carry it across a crash.
   */
  async resumeAfterRestart(note: string): Promise<void> {
    while (this.stopping) await this.stopping;
    if (this.deleted || this.ctx.closing) return;
    if (!this.run || this.run.exited) {
      if (this.ctx.store.undelivered(this.id).length) this.start();
      else await this.send(note, 'kelpie');
    }
    this.clearResumePending();
  }

  markResumePending(): void {
    this.update({ resumePending: true });
  }

  /** Something else (e.g. a new message) has picked this round-up up again. */
  clearResumePending(): void {
    if (this.row.resumePending) this.update({ resumePending: false });
  }

  /** Records that the orchestrator has been told about this sub-agent up to log index `index`. */
  markNotified(index: number): void {
    this.row = this.ctx.store.updateSession(this.id, { notifiedIdx: index }) ?? this.row;
  }

  /** Starts a harness process with every turn still undelivered, oldest first. */
  private start(): void {
    const { store, hooks } = this.ctx;
    const texts = store.undelivered(this.id).map((r) => r.text);
    if (!texts.length) return;
    const runId = randomUUID();
    const resume = this.row.harnessSessionId ?? undefined;
    const hadHistory = store.firstSent(this.id)?.deliveredAt != null;
    const run = this.ctx.adapter.start({
      ...this.ctx.defaults,
      ...(this.row.model ? { model: this.row.model } : {}),
      ...hooks.specFor?.(this, { runId, fresh: !resume, hadHistory }),
      cwd: this.cwd,
      prompt: texts[0]!,
      runId,
      ...(this.ctx.runsDir ? { runDir: join(this.ctx.runsDir, runId) } : {}),
      ...(resume ? { resume } : {}),
    });
    for (const text of texts.slice(1)) run.send(text);
    this.run = run;
    this.pumping = this.pump(run, resume);
  }

  async interrupt(): Promise<void> {
    await this.run?.interrupt();
  }

  rename(title: string): void {
    this.update({ title });
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

  private async pump(run: Run, resumed: string | undefined): Promise<void> {
    const log = this.load();
    let started = false;
    let retryFresh = false;
    this.pumpActive = true;
    try {
      for await (let event of run.events) {
        if (this.deleted) continue; // drain the process, log nothing
        let changed = false;
        if (event.kind === 'session.started') {
          started = true;
          if (event.data.harnessSessionId !== this.row.harnessSessionId) this.update({ harnessSessionId: event.data.harnessSessionId });
        } else if (event.kind === 'activity') {
          this.busyState = event.data.busy;
          if (event.data.busy) clearTimeout(this.idleTimer);
          else this.armIdle(run);
          changed = true;
        } else if (event.kind === 'rate_limit') {
          this.ctx.reportUsage(event.harness, event.data);
        } else if (event.kind === 'turn.ended') {
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
            event = { ...event, data: { ...event.data, source: row.source } };
          }
        }

        const index = log.push(event) - 1;
        // A process ending (idle timeout, daemon shutdown) is housekeeping: it must not reorder the list.
        const now = event.kind === 'process.exited' ? this.row.updatedAt : Date.now();
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
        // One broken subscriber must neither starve the others nor take the daemon down.
        for (const listener of this.listeners.keys()) {
          try {
            listener({ index, event });
          } catch (err) {
            console.error(`session ${this.id}: listener failed`, err);
          }
        }
        if (changed) this.ctx.changed(this);
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
    if (retryFresh && !this.deleted && !this.ctx.closing && this.run === run) this.start();
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

  constructor(opts: SessionManagerOptions) {
    this.store = opts.store;
    this.defaultCwd = opts.defaultCwd;
    this.ctx = {
      store: opts.store,
      defaults: opts.defaults ?? {},
      adapter: opts.adapter ?? claudeCode,
      runsDir: opts.runsDir,
      idleMs: opts.idleMs ?? 10 * 60_000,
      hooks: opts.hooks ?? {},
      closing: false,
      changed: (s) => this.notify({ type: 'session', session: s.info() }),
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
        this.notify({ type: 'usage', usage: this.usage() });
      },
    };
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
      id: randomUUID(),
      cwd,
      ...(model ? { model } : {}),
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      ...(opts.role ? { role: opts.role } : {}),
      ...(opts.writes ? { writes: true } : {}),
      ...(opts.title ? { title: opts.title } : {}),
    });
    const session = new Session(row, this.ctx);
    this.sessions.set(session.id, session);
    this.notify({ type: 'session', session: session.info() });
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
  async delete(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await Promise.all(this.children(id).map((c) => this.delete(c.id)));
    await session.delete();
    this.notify({ type: 'deleted', id });
    return true;
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

  /** Marks every round-up still working, so the next daemon start resumes it. Call before `stopAll`. */
  prepareShutdown(): void {
    this.ctx.closing = true;
    for (const s of this.sessions.values()) if (s.working) s.markResumePending();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.stop()));
  }

  private notify(update: ManagerUpdate): void {
    for (const listener of this.watchers) {
      try {
        listener(update);
      } catch (err) {
        console.error('session list listener failed', err);
      }
    }
  }
}
