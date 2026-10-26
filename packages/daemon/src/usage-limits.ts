import type { UsageLimitStop } from '@kelpie/adapters';
import type { KelpieEvent, TurnLimit, UsageLimitPause } from '@kelpie/protocol';
import type { Store, UsageLimitRow } from '@kelpie/store';

const MINUTE = 60_000;

/** Resumed this long after the reset: the harness's clock and the limit's may be a little apart. */
export const RESET_BUFFER_MS = 90_000;
/** Between resumes when many sessions pick up at once. */
export const STAGGER_MS = 5_000;
/** A probe that has neither hit the limit again nor shown it got through by then is taken as through. */
export const PROBE_MS = 2 * MINUTE;
/** Tries without a known reset before Kelpie stops resuming on its own: 15m, 30m, then hourly, about half a day. */
export const MAX_TRIES = 12;
/** Timers check again at least this often, so a machine waking from sleep catches up. */
const MAX_WAIT_MS = 5 * MINUTE;
/** A session due but working (the person sent it something) is looked at again this often. */
const RECHECK_MS = 30_000;
/** Refused again only just after its reset (the clocks are a little apart): tried again this soon. */
export const RECENT_RETRY_MS = 5 * MINUTE;
/** A reset this far off is not believed (no plan limit lasts longer than a week): it counts as unknown. */
export const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * MINUTE;

/** When to try again without a reset time: 15 minutes, then 30, then hourly. */
export const backoff = (attempts: number): number => (attempts <= 0 ? 15 : attempts === 1 ? 30 : 60) * MINUTE;

/** What Kelpie sends a session it resumes after the limit reset. */
export const LIMIT_RESUMED = 'Your usage limit has reset. Continue where you left off.';

/** A session as the scheduler needs to see it. */
export interface LimitTarget {
  readonly id: string;
  readonly harness: string;
  readonly role: 'orchestrator' | 'agent';
  readonly working: boolean;
  readonly createdAt: number;
}

/** How long the scheduler waits around a reset; shorter in tests. */
export interface LimitTiming {
  bufferMs: number;
  staggerMs: number;
  probeMs: number;
}

const TIMING: LimitTiming = { bufferMs: RESET_BUFFER_MS, staggerMs: STAGGER_MS, probeMs: PROBE_MS };

export interface UsageLimitsOptions {
  store: Store;
  /** The session, if it still exists. */
  get(id: string): LimitTarget | undefined;
  /** Resumes a session that was paused (a sub-agent may wait for a slot under the agent limit). */
  resume(id: string): Promise<void>;
  /** The person's setting: resume on its own at all. */
  enabled(): boolean;
  /** A session's pause changed (paused, rescheduled, cancelled, over): watchers hear. */
  changed(id: string): void;
  now?: () => number;
  timing?: Partial<LimitTiming>;
}

/**
 * Sessions paused at the person's usage limit, and when to resume them. A pause is kept in the
 * store (so a restart resumes what is due and schedules the rest) until the session runs again.
 *
 * Resuming goes one harness at a time: one due session is resumed first, as a probe. If it hits
 * the limit again, every paused session of that harness waits for the new time instead of each
 * finding out for itself; once it gets through, the rest follow, a few seconds apart. Sub-agents
 * are resumed through the orchestrator, so its agent limit holds.
 */
export class UsageLimits {
  private readonly rows = new Map<string, UsageLimitRow>();
  private readonly now: () => number;
  private readonly timing: LimitTiming;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private stopped = false;
  /** Each harness's probe in flight: the session resumed first, and when its time is up. */
  private readonly probes = new Map<string, { id: string; timer: ReturnType<typeof setTimeout> }>();
  /** Sessions resumed whose outcome (through, or limited again) is not known yet. */
  private readonly resuming = new Set<string>();
  /** Staggered resumes still to go out. */
  private readonly staggered = new Set<ReturnType<typeof setTimeout>>();
  /** When Kelpie last resumed each session after the limit. */
  private readonly resumed = new Map<string, number>();

  constructor(private readonly opts: UsageLimitsOptions) {
    this.now = opts.now ?? Date.now;
    this.timing = { ...TIMING, ...opts.timing };
    for (const row of opts.store.limits()) this.rows.set(row.sessionId, row);
  }

  /** A session's pause, as the UI and the orchestrator see it; undefined if it isn't paused. */
  pause(id: string): UsageLimitPause | undefined {
    const row = this.rows.get(id);
    if (!row) return undefined;
    return {
      since: row.createdAt,
      ...(row.resetsAt != null ? { resetsAt: row.resetsAt } : {}),
      ...(this.willResume(id) ? { retryAt: row.retryAt } : {}),
      attempts: row.attempts,
      message: row.message,
      ...(this.gaveUp(id) ? { gaveUp: true } : {}),
    };
  }

  /** Kelpie ran out of tries without the limit lifting, and left it to the person. */
  gaveUp(id: string): boolean {
    const row = this.rows.get(id);
    return !!row && !row.auto && row.attempts >= MAX_TRIES;
  }

  /** Paused, and Kelpie will resume it on its own. */
  willResume(id: string): boolean {
    return !!this.rows.get(id)?.auto && this.opts.enabled();
  }

  /** Every paused session's id. */
  paused(): string[] {
    return [...this.rows.keys()];
  }

  /** Starts resuming: what is due now (after a restart, say) goes, the rest is scheduled. */
  start(): void {
    if (this.stopped) return;
    this.started = true;
    this.arm();
  }

  /** Kelpie is shutting down: nothing more is resumed. Pauses stay in the store for the next start. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const p of this.probes.values()) clearTimeout(p.timer);
    this.probes.clear();
    for (const t of this.staggered) clearTimeout(t);
    this.staggered.clear();
  }

  /**
   * A turn of `session` stopped at the limit: it pauses until the reset (or a backoff), or, if it was
   * already paused, waits longer. If it was its harness's probe, every session of that harness
   * paused before it waits as long. Returns what the turn's log entry says of it.
   */
  hit(session: LimitTarget, stop: UsageLimitStop, given?: TurnLimit): TurnLimit {
    const now = this.now();
    const prev = this.rows.get(session.id);
    // A try of Kelpie's that found the limit still there counts; the person's own message doesn't.
    const attempts = (prev?.attempts ?? 0) + (prev && this.resuming.has(session.id) ? 1 : 0);
    this.resuming.delete(session.id);
    const told = stop.resetsAt?.getTime();
    const resetsAt = told !== undefined && told - now <= MAX_RESET_AHEAD_MS ? told : undefined;
    const known = resetsAt !== undefined && resetsAt + this.timing.bufferMs > now;
    // Refused although its reset has only just gone: the clocks differ a little, so soon, not a half-hour backoff.
    const recent = resetsAt !== undefined && !known && now - resetsAt < 60 * MINUTE;
    const retryAt = known ? resetsAt + this.timing.bufferMs : now + (recent ? RECENT_RETRY_MS : backoff(attempts));
    // Without a reset time to go by, it stops trying on its own after a while.
    const auto = (prev?.auto ?? true) && (known || attempts < MAX_TRIES);
    const row = this.opts.store.setLimit({ sessionId: session.id, harness: session.harness, message: stop.message, resetsAt: resetsAt ?? null, retryAt, attempts, auto }, now);
    this.rows.set(session.id, row);
    const probe = this.probes.get(session.harness);
    if (probe?.id === session.id) {
      clearTimeout(probe.timer);
      this.probes.delete(session.harness);
      this.holdBack(session.harness, retryAt, session.id);
    }
    this.opts.changed(session.id);
    this.arm();
    return {
      ...given,
      ...(resetsAt !== undefined ? { resetsAt: new Date(resetsAt).toISOString() } : {}),
      ...(this.willResume(session.id) ? { retryAt: new Date(retryAt).toISOString() } : {}),
      attempts,
    };
  }

  /**
   * Every logged event of every session: a paused one that gets through (its harness answers, a
   * tool runs, a turn ends otherwise) is paused no more, and the limit is evidently over for its
   * harness: the rest resume. One whose process ends before either is tried again later.
   */
  observe(session: LimitTarget, event: KelpieEvent): void {
    const row = this.rows.get(session.id);
    if (!row) return;
    if (through(event)) {
      this.clear(session.id);
      const probe = this.probes.get(session.harness);
      if (probe?.id === session.id) {
        clearTimeout(probe.timer);
        this.probes.delete(session.harness);
      }
      this.fanOut(session.harness, row);
    } else if (event.kind === 'process.exited' && this.resuming.has(session.id)) {
      // It never got as far as an answer (e.g. the harness would not start): later, as if limited again.
      this.resuming.delete(session.id);
      const probe = this.probes.get(session.harness);
      if (probe?.id === session.id) {
        clearTimeout(probe.timer);
        this.probes.delete(session.harness);
      }
      this.retryLater(session.id);
    }
  }

  /** The person's "Resume now": tried at once, as its harness's probe. False if it isn't paused, or is working. */
  resumeNow(id: string): boolean {
    const row = this.rows.get(id);
    const session = this.opts.get(id);
    if (!row || !session || session.working || this.stopped) return false;
    this.update(id, { auto: true, retryAt: Math.min(row.retryAt, this.now()) });
    this.probe(session);
    return true;
  }

  /** The person's "Don't auto-resume" (or an interrupt): it stays paused until someone sends it a turn. */
  cancel(id: string): boolean {
    const row = this.rows.get(id);
    if (!row) return false;
    this.resuming.delete(id);
    const probe = this.probes.get(row.harness);
    if (probe?.id === id) {
      clearTimeout(probe.timer);
      this.probes.delete(row.harness);
    }
    if (row.auto) this.update(id, { auto: false });
    this.arm();
    return true;
  }

  /** The session is gone. */
  forget(id: string): void {
    this.resuming.delete(id);
    this.resumed.delete(id);
    this.rows.delete(id);
  }

  /** The person turned auto-resume on or off: every pause shows it, and whatever is due goes. */
  settingChanged(): void {
    for (const id of this.rows.keys()) this.opts.changed(id);
    this.arm();
  }

  /** A try that came to nothing: later, by the backoff, and not on its own any more once the tries run out. */
  private retryLater(id: string): void {
    const row = this.rows.get(id);
    if (row) {
      const attempts = row.attempts + 1;
      this.update(id, { retryAt: this.now() + backoff(attempts), attempts, auto: row.auto && attempts < MAX_TRIES });
    }
    this.arm();
  }

  private clear(id: string): void {
    this.resuming.delete(id);
    if (!this.rows.delete(id)) return;
    this.opts.store.clearLimit(id);
    this.opts.changed(id);
  }

  private update(id: string, patch: Partial<Pick<UsageLimitRow, 'retryAt' | 'attempts' | 'auto'>>): void {
    const row = this.opts.store.updateLimit(id, patch);
    if (row) this.rows.set(id, row);
    this.opts.changed(id);
  }

  /** A probe found the limit still there: the harness's other pauses due before `until` wait for it too. */
  private holdBack(harness: string, until: number, except: string): void {
    for (const row of [...this.rows.values()]) {
      if (row.harness !== harness || row.sessionId === except || !row.auto || row.retryAt >= until || this.resuming.has(row.sessionId)) continue;
      this.update(row.sessionId, { retryAt: until });
    }
  }

  /**
   * Re-arms the timer for the next pause due (or sooner, to catch up after sleep). A harness with a
   * probe out waits for how it goes (its outcome re-arms); a session due but working is looked at
   * again in a while, not at once, or the timer would spin.
   */
  private arm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.started || this.stopped || !this.opts.enabled()) return;
    const now = this.now();
    const times = [...this.rows.values()]
      .filter((r) => r.auto && !this.resuming.has(r.sessionId) && !this.probes.has(r.harness))
      .map((r) => (r.retryAt <= now && this.opts.get(r.sessionId)?.working ? now + RECHECK_MS : r.retryAt));
    const next = Math.min(...times);
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => this.tick(), Math.min(MAX_WAIT_MS, Math.max(0, next - this.now())));
    this.timer.unref?.();
  }

  /** Resumes, per harness, one session due as a probe; the rest wait for how it goes. */
  private tick(): void {
    this.timer = undefined;
    if (this.stopped || !this.opts.enabled()) return;
    const now = this.now();
    const due = new Map<string, LimitTarget[]>();
    for (const row of this.rows.values()) {
      if (!row.auto || row.retryAt > now || this.resuming.has(row.sessionId)) continue;
      const session = this.opts.get(row.sessionId);
      if (!session) {
        this.forget(row.sessionId);
        continue;
      }
      // Working again already (the person sent it something): how that turn goes settles it.
      if (session.working) continue;
      due.set(row.harness, [...(due.get(row.harness) ?? []), session]);
    }
    for (const [harness, sessions] of due) {
      if (!this.probes.has(harness)) this.probe(order(sessions)[0]!);
    }
    this.arm();
  }

  private probe(session: LimitTarget): void {
    const prev = this.probes.get(session.harness);
    if (prev) clearTimeout(prev.timer);
    // Neither limited again nor through yet (still starting, or queued behind the agent limit): taken as through.
    const timer = setTimeout(() => {
      if (this.probes.get(session.harness)?.timer !== timer) return;
      this.probes.delete(session.harness);
      this.fanOut(session.harness, this.rows.get(session.id));
    }, this.timing.probeMs);
    timer.unref?.();
    this.probes.set(session.harness, { id: session.id, timer });
    this.send(session.id);
  }

  /**
   * `lifted`, a pause of `harness`, is over: the sessions paused at the same limit (the same reset
   * time) go, and any others already due, a few seconds apart. One at another limit (a weekly one,
   * while a 5-hour one lifted) waits for its own time.
   */
  private fanOut(harness: string, lifted: UsageLimitRow | undefined): void {
    if (this.stopped || !this.opts.enabled()) return;
    const now = this.now();
    const waiting = [...this.rows.values()]
      .filter((r) => r.harness === harness && r.auto && !this.resuming.has(r.sessionId) && (r.retryAt <= now || (!!lifted && r.resetsAt === lifted.resetsAt)))
      .flatMap((r) => {
        const s = this.opts.get(r.sessionId);
        return s && !s.working ? [s] : [];
      });
    order(waiting).forEach((s, i) => {
      // Marked now, so a tick meanwhile doesn't pick it as a probe too.
      this.resuming.add(s.id);
      const t = setTimeout(() => {
        this.staggered.delete(t);
        // Paused no more, the person said not to (or sent it something) meanwhile, or turned auto-resume off.
        if (this.stopped || !this.opts.enabled() || !this.rows.get(s.id)?.auto || this.opts.get(s.id)?.working !== false) {
          this.resuming.delete(s.id);
          return this.arm();
        }
        this.send(s.id);
      }, i * this.timing.staggerMs);
      t.unref?.();
      this.staggered.add(t);
    });
    this.arm();
  }

  /** Whether Kelpie resumed `id` after the limit at or after `since` (epoch ms), in this daemon's life. */
  resumedSince(id: string, since: number): boolean {
    return (this.resumed.get(id) ?? -Infinity) >= since;
  }

  private send(id: string): void {
    this.resuming.add(id);
    this.resumed.set(id, this.now());
    this.opts.resume(id).catch((err) => {
      console.error(`session ${id}: could not resume after the usage limit`, err);
      this.resuming.delete(id);
      this.retryLater(id);
    });
  }
}

/** Agents before their orchestrator (it hears they are resuming), oldest first. */
const order = (sessions: LimitTarget[]) => [...sessions].sort((a, b) => (a.role === b.role ? 0 : a.role === 'agent' ? -1 : 1) || a.createdAt - b.createdAt);

/** The harness got through: it reported usage that isn't refused, ran a tool, or ended a turn otherwise than at the limit. */
function through(event: KelpieEvent): boolean {
  switch (event.kind) {
    case 'rate_limit':
      return event.data.status !== 'rejected';
    case 'tool.started':
    case 'thinking':
      return !event.parentCallId;
    case 'turn.ended':
      return !event.data.limit && event.data.status !== 'interrupted';
    default:
      return false;
  }
}
