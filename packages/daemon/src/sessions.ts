import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { EventData, EventKind, KelpieEvent } from '@kelpie/protocol';
import { claudeCode, type Adapter, type Run, type RunSpec } from '@kelpie/adapters';
import type { SessionPatch, SessionRow, Store } from '@kelpie/store';

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
}

/** What subscribers receive. `index` is the event's position in the session log (stable across runs and restarts). */
export interface SessionUpdate {
  index: number;
  event: KelpieEvent;
}

/** What the round-up list stream carries. */
export type ManagerUpdate = { type: 'session'; session: SessionInfo } | { type: 'deleted'; id: string };

export type SessionDefaults = Omit<RunSpec, 'cwd' | 'prompt' | 'resume' | 'runId' | 'runDir'>;

export interface SessionManagerOptions {
  store: Store;
  defaultCwd: string;
  defaults?: SessionDefaults;
  adapter?: Adapter;
  /** Each run's raw stream goes to `<runsDir>/<runId>`; the adapter's default otherwise. */
  runsDir?: string;
  /** A harness process idle this long is stopped; the next message resumes it. */
  idleMs?: number;
}

interface SessionContext {
  store: Store;
  defaults: SessionDefaults;
  adapter: Adapter;
  runsDir: string | undefined;
  idleMs: number;
  changed: (s: Session) => void;
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

  info(): SessionInfo {
    const { id, title, cwd, createdAt, updatedAt, harnessSessionId } = this.row;
    return { id, title, cwd, createdAt, updatedAt, busy: this.busy, lastTurn: this.lastTurnState, harnessSessionId: harnessSessionId ?? undefined };
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
    for (const e of closing) store.appendEvent(this.id, idx++, e, this.row.updatedAt);
    if (busy) this.lastTurnState = 'interrupted';
  }

  async send(text: string): Promise<void> {
    while (this.stopping) await this.stopping;
    if (this.deleted) throw new Error('this round-up was deleted');
    this.load();
    if (this.run && !this.run.exited) this.run.send(text);
    else this.start(text);
    if (!this.row.title) this.update({ title: titleFrom(text) });
  }

  private start(text: string): void {
    const runId = randomUUID();
    const resume = this.row.harnessSessionId ?? undefined;
    const run = this.ctx.adapter.start({
      ...this.ctx.defaults,
      cwd: this.cwd,
      prompt: text,
      runId,
      ...(this.ctx.runsDir ? { runDir: join(this.ctx.runsDir, runId) } : {}),
      ...(resume ? { resume } : {}),
    });
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
    this.pumpActive = true;
    try {
      for await (const event of run.events) {
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
        } else if (event.kind === 'turn.ended') {
          this.lastTurnState = event.data.status;
          changed = true;
        } else if (event.kind === 'process.exited') {
          clearTimeout(this.idleTimer);
          // The harness could not resume (e.g. its transcript is gone): start afresh next time.
          if (resumed && !started && event.data.code) this.update({ harnessSessionId: null });
        }

        const index = log.push(event) - 1;
        // A process ending (idle timeout, daemon shutdown) is housekeeping: it must not reorder the list.
        const now = event.kind === 'process.exited' ? this.row.updatedAt : Date.now();
        try {
          this.ctx.store.appendEvent(this.id, index, event, now);
          this.row = { ...this.row, updatedAt: now };
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
      }
    } catch (err) {
      console.error(`session ${this.id}: event stream failed`, err);
    } finally {
      this.pumpActive = false;
      this.release();
    }
  }
}

export class SessionManager {
  readonly defaultCwd: string;
  private readonly store: Store;
  private readonly sessions = new Map<string, Session>();
  private readonly watchers = new Set<(u: ManagerUpdate) => void>();
  private readonly ctx: SessionContext;

  constructor(opts: SessionManagerOptions) {
    this.store = opts.store;
    this.defaultCwd = opts.defaultCwd;
    this.ctx = {
      store: opts.store,
      defaults: opts.defaults ?? {},
      adapter: opts.adapter ?? claudeCode,
      runsDir: opts.runsDir,
      idleMs: opts.idleMs ?? 10 * 60_000,
      changed: (s) => this.notify({ type: 'session', session: s.info() }),
    };
    for (const row of this.store.listSessions()) {
      const session = new Session(row, this.ctx);
      session.repair();
      this.sessions.set(session.id, session);
    }
  }

  create(cwd = this.defaultCwd): Session {
    const row = this.store.createSession({ id: randomUUID(), cwd, ...(this.ctx.defaults.model ? { model: this.ctx.defaults.model } : {}) });
    const session = new Session(row, this.ctx);
    this.sessions.set(session.id, session);
    this.notify({ type: 'session', session: session.info() });
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Most recently active first. */
  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info()).sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }

  async delete(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await session.delete();
    this.notify({ type: 'deleted', id });
    return true;
  }

  /** Round-up list changes: creations, renames, busy flips, finished turns, deletions. */
  watch(listener: (u: ManagerUpdate) => void): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
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
