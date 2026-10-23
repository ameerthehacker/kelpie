import { randomUUID } from 'node:crypto';
import type { KelpieEvent } from '@kelpie/protocol';
import { claudeCode, type Adapter, type Run, type RunSpec } from '@kelpie/adapters';

export interface SessionInfo {
  id: string;
  cwd: string;
  createdAt: string;
  busy: boolean;
  /** The harness's own session id, once known; reused to resume after the process exits. */
  harnessSessionId: string | undefined;
}

/** What subscribers receive. `index` is the event's position in the session log (stable across runs). */
export interface SessionUpdate {
  index: number;
  event: KelpieEvent;
}

export type SessionDefaults = Omit<RunSpec, 'cwd' | 'prompt' | 'resume' | 'runId' | 'runDir'>;

/**
 * One chat: a log of KEF events across however many harness processes it
 * takes. If the process exits, the next message starts a new one that
 * resumes the same harness session. In memory only until the store lands.
 */
export class Session {
  readonly id = randomUUID();
  readonly createdAt = new Date().toISOString();
  private readonly log: KelpieEvent[] = [];
  private readonly listeners = new Set<(u: SessionUpdate) => void>();
  private run: Run | undefined;
  private harnessSessionId: string | undefined;
  /** As of the last logged `activity` event, so it never runs ahead of what subscribers have seen. */
  private busyState = false;

  constructor(
    readonly cwd: string,
    private readonly defaults: SessionDefaults = {},
    private readonly adapter: Adapter = claudeCode,
  ) {}

  get busy(): boolean {
    return this.busyState;
  }

  info(): SessionInfo {
    return { id: this.id, cwd: this.cwd, createdAt: this.createdAt, busy: this.busy, harnessSessionId: this.harnessSessionId };
  }

  send(text: string): void {
    if (this.run && !this.run.exited) {
      this.run.send(text);
    } else {
      const run = this.adapter.start({
        ...this.defaults,
        cwd: this.cwd,
        prompt: text,
        ...(this.harnessSessionId ? { resume: this.harnessSessionId } : {}),
      });
      this.run = run;
      void this.pump(run);
    }
  }

  async interrupt(): Promise<void> {
    await this.run?.interrupt();
  }

  async stop(): Promise<void> {
    await this.run?.stop();
  }

  /** Replays the log from `fromIndex`, then streams live updates until unsubscribed. */
  subscribe(listener: (u: SessionUpdate) => void, fromIndex = 0): () => void {
    for (let i = Math.max(0, fromIndex); i < this.log.length; i++) listener({ index: i, event: this.log[i]! });
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async pump(run: Run): Promise<void> {
    try {
      for await (const event of run.events) {
        if (event.kind === 'session.started') this.harnessSessionId = event.data.harnessSessionId;
        if (event.kind === 'activity') this.busyState = event.data.busy;
        const index = this.log.push(event) - 1;
        // One broken subscriber must neither starve the others nor take the daemon down.
        for (const listener of this.listeners) {
          try {
            listener({ index, event });
          } catch (err) {
            console.error(`session ${this.id}: listener failed`, err);
          }
        }
      }
    } catch (err) {
      console.error(`session ${this.id}: event stream failed`, err);
    }
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    readonly defaultCwd: string,
    private readonly defaults: SessionDefaults = {},
    private readonly adapter: Adapter = claudeCode,
  ) {}

  create(cwd = this.defaultCwd): Session {
    const s = new Session(cwd, this.defaults, this.adapter);
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.stop()));
  }
}
