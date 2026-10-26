import { isPlan, isQuestion, type PendingApproval } from './approvals.js';
import { clock } from './limits.js';
import { roundUpPath, titleOf as roundUpTitle, type RoundUp } from './round-ups.js';

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
  /**
   * `needed`: approvals, questions, plans and failures straight away, and Kelpie's (the orchestrator's) replies
   * once its round-up has gone fully idle. `all`: also every sub-agent finishing.
   */
  level: AttentionLevel;
}

/** Off until the person turns them on. */
export const DEFAULT_SETTINGS: AttentionSettings = { enabled: false, sound: true, level: 'needed' };

/** Stored settings, with the defaults for whatever is missing or malformed. */
export function parseSettings(raw: string | null): AttentionSettings {
  try {
    const v = (JSON.parse(raw ?? '{}') ?? {}) as Partial<AttentionSettings>;
    return {
      enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_SETTINGS.enabled,
      sound: typeof v.sound === 'boolean' ? v.sound : DEFAULT_SETTINGS.sound,
      level: v.level === 'all' ? 'all' : DEFAULT_SETTINGS.level,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * In priority order: what a mixed bundle leads with and where clicking it goes. Of the usage limit:
 * `gave-up`, Kelpie stopped resuming work on its own and it needs the person; `paused`, work stopped
 * at the limit and Kelpie will resume it; `resumed`, it picked up again.
 */
export const ATTENTION_KINDS = ['approval', 'question', 'plan', 'gave-up', 'failed', 'paused', 'reply', 'finished', 'resumed'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/**
 * How a bundle is put to the person. `alert`: a banner and the chime (within the cooldown). `quiet`:
 * a notification, never the chime: work paused at the limit needs nothing of them, maybe at night.
 * `update`: only an update of a notification already showing (a resume): nothing new appears.
 */
export type Loudness = 'alert' | 'quiet' | 'update';

/** The loudness a bundle of `kinds` calls for: its loudest. */
export function loudness(kinds: readonly AttentionKind[]): Loudness {
  if (kinds.some((k) => k !== 'paused' && k !== 'resumed')) return 'alert';
  return kinds.includes('paused') ? 'quiet' : 'update';
}

export interface Attention {
  kind: AttentionKind;
  roundUpId: string;
  sessionId: string;
  /** Who it is about: an agent's title, or Kelpie (the orchestrator). */
  who: string;
  /** One per thing: the same thing again replaces it rather than counting twice. */
  key: string;
  /** For `paused`: when Kelpie resumes it (epoch ms), if it will on its own. */
  until?: number;
}

/** Close-together things are bundled: a window opens with the first and closes this long after. */
export const BUNDLE_MS = 3_000;
/** A banner and the chime at most this often; bundles in between update the notification quietly. */
export const ALERT_COOLDOWN_MS = 30_000;

type SessionLike = Pick<RoundUp, 'id' | 'title' | 'busy' | 'lastTurn' | 'parentId' | 'limited'>;

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
 * A round-up has gone fully idle: Kelpie (its orchestrator) isn't busy and none of its sub-agents is
 * working. Kelpie takes a turn whenever agents report in; only once everything has stopped is its
 * reply (a roll-up, a question) the person's to pick up.
 */
export function fullyIdle(roundUpId: string, sessions: Iterable<SessionLike>): boolean {
  for (const s of sessions) if (s.busy && (s.id === roundUpId || s.parentId === roundUpId)) return false;
  return true;
}

/**
 * What a session update asks of the person. Kelpie's finished turn is a reply to them if `idle`
 * (its round-up has gone fully idle, see `fullyIdle`); turns in between — "I've started 5 agents",
 * one agent's report while others work — are not. A sub-agent finishing is not either — Kelpie
 * hears of it and rolls it up — unless they asked for every agent. Failures always are. A turn that
 * stopped at the usage limit is no failure: work paused (once per pause, its `since`), and a paused
 * session picking up again is news too, both quietly. Kelpie giving up on resuming it needs the person.
 */
export function classifySession(prev: SessionLike | undefined, next: SessionLike, level: AttentionLevel, idle: boolean): Attention | undefined {
  const top = !next.parentId;
  const base = { roundUpId: next.parentId ?? next.id, sessionId: next.id, who: top ? 'Kelpie' : next.title || 'An agent' };
  if (prev?.limited && !next.limited && next.busy) return { ...base, kind: 'resumed', key: `resumed:${next.id}:${prev.limited.since}` };
  if (next.limited?.gaveUp && !prev?.limited?.gaveUp) return { ...base, kind: 'gave-up', key: `gave-up:${next.id}:${next.limited.since}` };
  const ended = endedTurn(prev, next);
  if (!ended) return undefined;
  if (ended === 'failed' && next.limited) return { ...base, kind: 'paused', key: `paused:${next.id}:${next.limited.since}`, ...(next.limited.retryAt ? { until: next.limited.retryAt } : {}) };
  if (ended === 'failed') return { ...base, kind: 'failed', key: `failed:${next.id}` };
  if (top) return idle ? { ...base, kind: 'reply', key: `reply:${next.id}` } : undefined;
  return level === 'all' ? { ...base, kind: 'finished', key: `finished:${next.id}` } : undefined;
}

export const approvalKey = (a: Pick<PendingApproval, 'sessionId' | 'requestId'>) => `${a.sessionId}:${a.requestId}`;

/** What kind of thing an open request asks of the person. */
export const requestKind = (a: PendingApproval): 'approval' | 'question' | 'plan' => (isPlan(a) ? 'plan' : isQuestion(a) ? 'question' : 'approval');

/** The kinds that are open requests: news only while still open. */
export const isRequestKind = (k: AttentionKind) => k === 'approval' || k === 'question' || k === 'plan';

/** Approvals, questions and plans not seen before. */
export function newApprovals(known: ReadonlySet<string>, list: readonly PendingApproval[]): Attention[] {
  return list
    .filter((a) => !known.has(approvalKey(a)))
    .map((a) => ({
      kind: requestKind(a),
      roundUpId: a.roundUpId,
      sessionId: a.sessionId,
      // The orchestrator asks as Kelpie.
      who: a.sessionId === a.roundUpId ? 'Kelpie' : a.agentTitle,
      key: `${requestKind(a)}:${approvalKey(a)}`,
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
  const questions = of('question');
  if (questions.length) {
    const askers = distinct(questions, (i) => i.sessionId);
    lines.push(askers === 1 ? `${questions[0]!.who} has ${plural(questions.length, 'a question', 'questions')}` : `${askers} agents have questions`);
  }
  const plans = of('plan');
  if (plans.length) lines.push(plural(plans.length, 'A plan is ready for review', `${plans.length} plans are ready for review`));
  const gaveUp = of('gave-up');
  if (gaveUp.length) {
    const n = distinct(gaveUp, (i) => i.sessionId);
    lines.push(n === 1 ? `${gaveUp[0]!.who} is still at the usage limit: resume it when you can` : `${n} agents are still at the usage limit: resume them when you can`);
  }
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
  const paused = of('paused');
  if (paused.length) {
    const who = distinct(paused, (i) => i.sessionId) === 1 && paused[0]!.who !== 'Kelpie' ? `${paused[0]!.who} paused` : 'Paused';
    const at = paused.map((i) => i.until).filter((t): t is number => !!t).sort((a, b) => a - b)[0];
    lines.push(at ? `${who} until ${clock(at, Date.now())} · Kelpie will resume automatically` : `${who} at the usage limit`);
  }
  const resumed = of('resumed');
  if (resumed.length) {
    const n = distinct(resumed, (i) => i.sessionId);
    lines.push(n === 1 ? `${resumed[0]!.who} resumed after the usage limit` : `${n} agents resumed after the usage limit`);
  }

  const lead = ATTENTION_KINDS.map(of).find((list) => list.length)!;
  const queued = lead[0]!.kind === 'approval' || lead[0]!.kind === 'question';
  const path = queued && distinct(lead, (i) => i.roundUpId) > 1 ? '/approvals' : roundUpPath(lead[0]!.roundUpId);
  // Only work waiting on the usage limit: nothing for the person to do.
  const waitingOnLimit = items.every((i) => i.kind === 'paused' || i.kind === 'resumed');
  return {
    title: one ? titleOf(roundUps[0]!) : `${roundUps.length} round-ups${waitingOnLimit ? '' : ' need you'}`,
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
  /** The person isn't looking at Kelpie (in any tab): only then are they notified. */
  away: () => boolean;
  /**
   * The last notification is still in the tray (not dismissed, nor closed as they came back): only
   * then can a bundle inside the cooldown update it quietly. Without one, it waits for the cooldown.
   */
  showing?: () => boolean;
  deliver: (d: Delivery) => void;
}

export interface AttentionTracker {
  /**
   * The round-up list, as the stream sends it on every (re)connect: the state of things, never news.
   * Sub-agents are forgotten too, until `subAgents` (sent straight after) says where they are.
   */
  sessions(list: readonly SessionLike[]): void;
  /** Every sub-agent, as the stream (re)connects: the state of things, never news. */
  subAgents(list: readonly SessionLike[]): void;
  /** One session (a round-up or a sub-agent) changed. */
  session(next: SessionLike): void;
  /** A round-up or a sub-agent was deleted. */
  deleted(id: string): void;
  /** Every round-up's open approvals, as the stream (re)connects: the state of things, never news. */
  approvalsSnapshot(list: readonly PendingApproval[]): void;
  /** One round-up's open approvals, whenever they change. */
  approvals(roundUpId: string, list: readonly PendingApproval[]): void;
  /** The person is looking again: what they were notified of is no longer news. */
  seen(): void;
  /** What has been notified since they last looked. */
  unseen(): readonly Attention[];
  subscribe(listener: () => void): () => void;
}

export function createAttention(opts: AttentionOptions): AttentionTracker {
  const known = new Map<string, SessionLike>();
  const pending = new Map<string, PendingApproval>();
  let bundle: Attention[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** A banner held back until the cooldown is over, there being no notification to update quietly. */
  let held: ReturnType<typeof setTimeout> | undefined;
  let unseen = new Map<string, Attention>();
  let unseenList: readonly Attention[] = [];
  let lastAlert = -Infinity;
  const listeners = new Set<() => void>();

  const changed = () => {
    unseenList = [...unseen.values()];
    listeners.forEach((l) => l());
  };
  const titleOf = (id: string) => roundUpTitle(known.get(id));
  // Answered meanwhile (here, on another device, by a saved rule): no longer news.
  const live = (i: Attention) => !isRequestKind(i.kind) || pending.has(i.key.slice(i.kind.length + 1));
  // Kelpie (or an agent) started again within the bundle window: the reply was one in between.
  const settled = (i: Attention) => i.kind !== 'reply' || fullyIdle(i.roundUpId, known.values());

  /**
   * Puts everything unseen to the person: a banner and the chime, or a quiet update inside the
   * cooldown. Quiet news (see `Loudness`) never chimes, and leaves the cooldown be.
   */
  const notify = (how: Loudness = 'alert') => {
    for (const [k, i] of unseen) if (!live(i)) unseen.delete(k);
    changed();
    const summary = summarize(unseenList, titleOf);
    if (!summary) return;
    if (how === 'update') return (opts.showing?.() ?? true) ? opts.deliver({ summary, alert: false }) : undefined;
    if (how === 'quiet') return opts.deliver({ summary, alert: false });
    const t = Date.now();
    const wait = lastAlert + ALERT_COOLDOWN_MS - t;
    if (wait <= 0) {
      lastAlert = t;
      opts.deliver({ summary, alert: true });
    } else if (opts.showing?.() ?? true) {
      opts.deliver({ summary, alert: false });
    } else {
      held ??= setTimeout(() => {
        held = undefined;
        if (opts.away()) notify();
      }, wait);
    }
  };

  const flush = () => {
    timer = undefined;
    const fresh = bundle.filter((i) => live(i) && settled(i));
    bundle = [];
    if (!fresh.length || !opts.away()) return;
    for (const i of fresh) unseen.set(i.key, i);
    notify(loudness(fresh.map((i) => i.kind)));
  };

  /** Pauses (and give-ups) already put to the person, by key: a session limited again keeps its pause, and is not news twice. */
  const told = new Set<string>();
  const once = (i: Attention) => i.kind === 'paused' || i.kind === 'gave-up';
  const add = (items: Attention[]) => {
    const { enabled } = opts.settings();
    const fresh = items.filter((i) => !once(i) || !told.has(i.key));
    if (!enabled || !fresh.length) return;
    for (const i of fresh) if (once(i)) told.add(i.key);
    bundle.push(...fresh);
    timer ??= setTimeout(flush, BUNDLE_MS);
  };

  /** Swaps in an approvals list; what wasn't open before is news. */
  const replace = (keep: (a: PendingApproval) => boolean, list: readonly PendingApproval[], news: boolean) => {
    const before = new Set(pending.keys());
    for (const [k, a] of pending) if (!keep(a)) pending.delete(k);
    for (const a of list) pending.set(approvalKey(a), a);
    if (news) add(newApprovals(before, list));
  };

  return {
    sessions(list) {
      known.clear();
      for (const s of list) known.set(s.id, s);
    },
    subAgents(list) {
      for (const s of list) known.set(s.id, s);
    },
    session(next) {
      const prev = known.get(next.id);
      known.set(next.id, next);
      const item = classifySession(prev, next, opts.settings().level, fullyIdle(next.parentId ?? next.id, known.values()));
      if (item) add([item]);
    },
    deleted(id) {
      known.delete(id);
      const about = (i: Attention) => i.roundUpId === id || i.sessionId === id;
      bundle = bundle.filter((i) => !about(i));
      if (![...unseen.values()].some(about)) return;
      for (const [k, i] of unseen) if (about(i)) unseen.delete(k);
      changed();
    },
    approvalsSnapshot: (list) => replace(() => false, list, false),
    approvals: (roundUpId, list) => replace((a) => a.roundUpId !== roundUpId, list, true),
    seen() {
      clearTimeout(held);
      held = undefined;
      if (!unseen.size) return;
      unseen = new Map();
      changed();
    },
    unseen: () => unseenList,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
