import { isPlan, type PendingApproval } from './approvals.js';
import { NEW_TITLE, roundUpPath, type RoundUp } from './round-ups.js';

/**
 * What needs the person, worked out from the daemon's event stream; and how it is put to them
 * without a flood when many agents run: close-together things are bundled into one notification,
 * at most one notification sits in the tray (each replaces the last), and the banner and chime
 * have a cooldown.
 */

export type AttentionLevel = 'needed' | 'all';

export interface AttentionSettings {
  enabled: boolean;
  sound: boolean;
  /** `needed`: approvals, plans, Kelpie's replies and failures. `all`: also every sub-agent finishing. */
  level: AttentionLevel;
}

/** In priority order: what a mixed bundle leads with and where clicking it goes. */
export const ATTENTION_KINDS = ['approval', 'plan', 'failed', 'reply', 'finished'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export interface Attention {
  kind: AttentionKind;
  roundUpId: string;
  sessionId: string;
  /** Who it is about: an agent's title, or Kelpie (the orchestrator). */
  who: string;
  /** One per thing: the same thing again replaces it rather than counting twice. */
  key: string;
}

/** Close-together things are bundled: a window opens with the first and closes this long after. */
export const BUNDLE_MS = 3_000;
/** A banner and the chime at most this often; bundles in between update the notification quietly. */
export const ALERT_COOLDOWN_MS = 30_000;

type SessionLike = Pick<RoundUp, 'id' | 'title' | 'busy' | 'lastTurn' | 'parentId'>;

/**
 * A session's turn that has just ended, from two consecutive updates: busy, then not. The daemon
 * logs `turn.ended` before the `activity` that clears busy, so `lastTurn` is the turn's by then.
 * Interrupted turns are the person's own doing.
 */
export function endedTurn(prev: SessionLike | undefined, next: SessionLike): 'completed' | 'failed' | undefined {
  if (!prev?.busy || next.busy) return undefined;
  return next.lastTurn === 'completed' || next.lastTurn === 'failed' ? next.lastTurn : undefined;
}

/**
 * What a session update asks of the person. Kelpie's (the orchestrator's) finished turn is a reply
 * to them; a sub-agent finishing is not — Kelpie hears of it and rolls it up — unless they asked
 * for every agent. Failures always are.
 */
export function classifySession(prev: SessionLike | undefined, next: SessionLike, level: AttentionLevel): Attention | undefined {
  const ended = endedTurn(prev, next);
  if (!ended) return undefined;
  const top = !next.parentId;
  const base = { roundUpId: next.parentId ?? next.id, sessionId: next.id, who: top ? 'Kelpie' : next.title || 'An agent' };
  if (ended === 'failed') return { ...base, kind: 'failed', key: `failed:${next.id}` };
  if (top) return { ...base, kind: 'reply', key: `reply:${next.id}` };
  return level === 'all' ? { ...base, kind: 'finished', key: `finished:${next.id}` } : undefined;
}

export const approvalKey = (a: Pick<PendingApproval, 'sessionId' | 'requestId'>) => `${a.sessionId}:${a.requestId}`;

/** Approvals and plans not seen before. */
export function newApprovals(known: ReadonlySet<string>, list: readonly PendingApproval[]): Attention[] {
  return list
    .filter((a) => !known.has(approvalKey(a)))
    .map((a) => ({
      kind: isPlan(a) ? 'plan' : 'approval',
      roundUpId: a.roundUpId,
      sessionId: a.sessionId,
      who: a.agentTitle,
      key: `${isPlan(a) ? 'plan' : 'approval'}:${approvalKey(a)}`,
    }));
}

export interface AttentionSummary {
  title: string;
  body: string;
  /** Where clicking it goes. */
  path: string;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** One notification for a bundle: "Fix login" / "3 agents need approval · Kelpie replied". */
export function summarize(items: readonly Attention[], titleOf: (roundUpId: string) => string): AttentionSummary | undefined {
  if (!items.length) return undefined;
  const of = (kind: AttentionKind) => items.filter((i) => i.kind === kind);
  const distinct = (list: Attention[], by: (i: Attention) => string) => new Set(list.map(by)).size;
  const roundUps = [...new Set(items.map((i) => i.roundUpId))];
  const one = roundUps.length === 1;
  const lines: string[] = [];

  const asks = of('approval');
  if (asks.length) {
    const agents = distinct(asks, (i) => i.sessionId);
    lines.push(agents === 1 ? `${asks[0]!.who} needs approval` : `${agents} agents need approval`);
  }
  const plans = of('plan');
  if (plans.length) lines.push(plural(plans.length, 'A plan is ready for review', `${plans.length} plans are ready for review`));
  const failed = of('failed');
  if (failed.length) {
    const f = failed[0]!;
    lines.push(failed.length > 1 ? `${failed.length} agents failed` : f.sessionId === f.roundUpId ? 'Kelpie’s turn failed' : `${f.who} failed`);
  }
  const replies = of('reply');
  if (replies.length) {
    const n = distinct(replies, (i) => i.roundUpId);
    lines.push(one ? 'Kelpie replied' : n === 1 ? `Kelpie replied in ${titleOf(replies[0]!.roundUpId)}` : `Kelpie replied in ${n} round-ups`);
  }
  const finished = of('finished');
  if (finished.length) lines.push(finished.length === 1 ? `${finished[0]!.who} finished` : `${finished.length} agents finished`);

  const lead = ATTENTION_KINDS.map(of).find((list) => list.length)!;
  const path = lead[0]!.kind === 'approval' && distinct(lead, (i) => i.roundUpId) > 1 ? '/approvals' : roundUpPath(lead[0]!.roundUpId);
  return {
    title: one ? titleOf(roundUps[0]!) : `${roundUps.length} round-ups need you`,
    body: lines.join(' · '),
    path,
  };
}

export interface Delivery {
  summary: AttentionSummary;
  /** A fresh banner and the chime; otherwise the notification is updated in place. */
  alert: boolean;
}

export interface AttentionOptions {
  settings: () => AttentionSettings;
  /** The tab is hidden or the window isn't focused: only then is the person notified. */
  away: () => boolean;
  deliver: (d: Delivery) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface AttentionTracker {
  /** The round-up list, as the stream sends it on every (re)connect. */
  sessions(list: readonly SessionLike[]): void;
  /** One session (a round-up or a sub-agent) changed. */
  session(next: SessionLike): void;
  /** Every round-up's open approvals, as the stream connects. */
  approvalsSnapshot(list: readonly PendingApproval[]): void;
  /** One round-up's open approvals, whenever they change. */
  approvals(roundUpId: string, list: readonly PendingApproval[]): void;
  /** The person is looking again: what they were notified of is no longer news. */
  seen(): void;
  /** What has been notified since they last looked. */
  unseen(): readonly Attention[];
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export function createAttention(opts: AttentionOptions): AttentionTracker {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const known = new Map<string, SessionLike>();
  const pending = new Map<string, PendingApproval>();
  let seededSessions = false;
  let seededApprovals = false;
  let bundle: Attention[] = [];
  let timer: unknown;
  let unseen = new Map<string, Attention>();
  let unseenList: readonly Attention[] = [];
  let lastAlert = -Infinity;
  const listeners = new Set<() => void>();

  const changed = () => {
    unseenList = [...unseen.values()];
    listeners.forEach((l) => l());
  };
  const titleOf = (id: string) => known.get(id)?.title || NEW_TITLE;
  // Answered meanwhile (here, on another device, by a saved rule): no longer news.
  const live = (i: Attention) => (i.kind !== 'approval' && i.kind !== 'plan') || pending.has(i.key.slice(i.kind.length + 1));

  const flush = () => {
    timer = undefined;
    const fresh = bundle.filter(live);
    bundle = [];
    if (!fresh.length || !opts.away()) return;
    for (const i of fresh) unseen.set(i.key, i);
    for (const [k, i] of unseen) if (!live(i)) unseen.delete(k);
    changed();
    const summary = summarize(unseenList, titleOf);
    if (!summary) return;
    const t = now();
    const alert = t - lastAlert >= ALERT_COOLDOWN_MS;
    if (alert) lastAlert = t;
    opts.deliver({ summary, alert });
  };

  const add = (items: Attention[]) => {
    const { enabled } = opts.settings();
    if (!enabled || !items.length) return;
    bundle.push(...items);
    timer ??= setTimer(flush, BUNDLE_MS);
  };

  const observe = (next: SessionLike, notify: boolean) => {
    const prev = known.get(next.id);
    known.set(next.id, next);
    if (!notify) return;
    const item = classifySession(prev, next, opts.settings().level);
    if (item) add([item]);
  };

  /** Swaps in an approvals list; what wasn't open before is news. */
  const replace = (keep: (a: PendingApproval) => boolean, list: readonly PendingApproval[], notify: boolean) => {
    const before = new Set(pending.keys());
    for (const [k, a] of pending) if (!keep(a)) pending.delete(k);
    for (const a of list) pending.set(approvalKey(a), a);
    if (notify) add(newApprovals(before, list));
  };

  return {
    sessions(list) {
      for (const s of list) observe(s, seededSessions);
      seededSessions = true;
    },
    session: (next) => observe(next, seededSessions),
    approvalsSnapshot(list) {
      replace(() => false, list, seededApprovals);
      seededApprovals = true;
    },
    approvals: (roundUpId, list) => replace((a) => a.roundUpId !== roundUpId, list, seededApprovals),
    seen() {
      if (!unseen.size) return;
      unseen = new Map();
      changed();
    },
    unseen: () => unseenList,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      bundle = [];
    },
  };
}
