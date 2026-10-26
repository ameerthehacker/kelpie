import type { EventSourceMessage } from '@microsoft/fetch-event-source';
import type { QueryClient } from '@tanstack/react-query';
import { differenceInCalendarDays, format, isSameDay } from 'date-fns';
import { DONE_FOR, workbenchPath, type CardRemoved, type ItemStatus, type Stage, type WorkbenchCard, type WorkbenchItem, type WorkbenchNote } from '@kelpie/protocol';
import { api, isGone } from './api.js';
import type { PendingApproval } from './approvals.js';

export const WORKBENCH_ROUTE = '/workbench/:cardId';

/** Every card on the Workbench: fetched once, then kept live by the daemon's event stream (see `workbenchStream`). */
export const WORKBENCH = ['workbench'] as const;

/**
 * The board's query. A daemon without the Workbench answers 404: that isn't retried, and isn't
 * fetched again on every mount; the stream's `workbench` snapshot fills the board once there is one.
 */
export const workbenchQuery = {
  queryKey: WORKBENCH,
  queryFn: () => api<WorkbenchCard[]>('GET', '/api/workbench'),
  retry: (failures: number, err: Error) => !isGone(err) && failures < 1,
  retryOnMount: false,
};

const NO_CARDS: WorkbenchCard[] = [];

/** The board as the page shows it: a daemon without the Workbench gets an empty board and a note, not an error. */
export function boardOf(data: WorkbenchCard[] | undefined, error: Error | null): { cards?: WorkbenchCard[]; error?: string; unavailable: boolean } {
  if (data === undefined && isGone(error)) return { cards: NO_CARDS, unavailable: true };
  return { cards: data, error: error?.message, unavailable: false };
}

/** The Workbench's handlers on the daemon's event stream (see use-round-ups). */
export function workbenchStream(queryClient: QueryClient) {
  // A list being fetched may predate this change: fetch it again rather than lose it. Cancelled
  // first, as a first load (no data yet) would otherwise take the refetch as the same fetch.
  const change = (f: (list: WorkbenchCard[] | undefined) => WorkbenchCard[] | undefined) => {
    if (queryClient.getQueryState(WORKBENCH)?.fetchStatus === 'fetching') {
      void queryClient.cancelQueries({ queryKey: WORKBENCH });
      void queryClient.refetchQueries({ queryKey: WORKBENCH });
    } else queryClient.setQueryData<WorkbenchCard[]>(WORKBENCH, f);
  };
  return {
    // Every card on the board as the stream connects; it wins over a fetch still on its way.
    workbench: (msg: EventSourceMessage) => {
      void queryClient.cancelQueries({ queryKey: WORKBENCH });
      queryClient.setQueryData(WORKBENCH, JSON.parse(msg.data) as WorkbenchCard[]);
    },
    // Then each card as it changes.
    card: (msg: EventSourceMessage) => change((list) => upsertCard(list, JSON.parse(msg.data) as WorkbenchCard)),
    'card-removed': (msg: EventSourceMessage) => change((list) => dropCard(list, (JSON.parse(msg.data) as CardRemoved).id)),
  };
}

/** The board's columns, left to right, with the dot each shows. */
export const STAGES: { stage: Stage; label: string; dot: string }[] = [
  { stage: 'blocked', label: 'Blocked', dot: 'bg-wait' },
  { stage: 'building', label: 'Building', dot: 'bg-run' },
  { stage: 'review', label: 'In review', dot: 'bg-vio' },
  { stage: 'ready', label: 'Ready to merge', dot: 'bg-done' },
  { stage: 'done', label: 'Done', dot: 'bg-mu2' },
];

const PILLS: Record<ItemStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-chip text-mu' },
  checks: { label: 'Checks running', className: 'bg-run/10 text-run' },
  review: { label: 'Needs your review', className: 'bg-wbg text-wait' },
  approved: { label: 'Approved', className: 'bg-chip text-fg3' },
  merged: { label: 'Merged', className: 'bg-chip text-mu' },
  blocked: { label: 'Blocked', className: 'bg-fail/10 text-fail' },
  closed: { label: 'Closed', className: 'bg-chip text-fa' },
};

/** An item's status as the pill on its row shows it. */
export const pillOf = (status: ItemStatus) => PILLS[status];

/** What the person should look at first: their reviews, then what is stuck, then what is moving. */
const RANK: Record<ItemStatus, number> = { review: 0, blocked: 1, checks: 2, draft: 3, approved: 4, merged: 5, closed: 6 };

/** The `n` items a card shows: by `RANK`, then the newest. */
export function topItems(items: readonly WorkbenchItem[], n = 3): WorkbenchItem[] {
  return [...items].sort((a, b) => RANK[a.status] - RANK[b.status] || b.updatedAt - a.updatedAt).slice(0, n);
}

/**
 * The line under a card's items, for those it doesn't show: "+ 56 more · 39 merged · 11 in review ·
 * 6 blocked". "No pull requests yet" when it has none; nothing when every item is shown.
 */
export function tally(items: readonly WorkbenchItem[], shown = 3): string | undefined {
  if (!items.length) return 'No pull requests yet';
  const shownKeys = new Set(topItems(items, shown).map((i) => i.key));
  const rest = items.filter((i) => !shownKeys.has(i.key));
  if (!rest.length) return undefined;
  const count = (s: ItemStatus) => rest.filter((i) => i.status === s).length;
  const parts = [`+ ${rest.length} more`];
  for (const [s, label] of [
    ['merged', 'merged'],
    ['review', 'in review'],
    ['blocked', 'blocked'],
  ] as const) {
    const c = count(s);
    if (c) parts.push(`${c} ${label}`);
  }
  return parts.join(' · ');
}

/** A card's footer: how its agents are doing, and how many things wait on the person. */
export function footer(card: Pick<WorkbenchCard, 'agents' | 'needsYou'>): { agents: string; needsYou?: string } {
  const { total, working } = card.agents;
  const agents =
    total === 0
      ? 'No agents yet'
      : total === 1
        ? `1 agent · ${working ? 'working' : 'idle'}`
        : working
          ? `${working} of ${total} agents working`
          : `${total} agents · idle`;
  return { agents, needsYou: card.needsYou > 0 ? `${card.needsYou} need${card.needsYou === 1 ? 's' : ''} you` : undefined };
}

/** When a card last changed, for its chat line: `10:28` today, `Fri` this past week, else `3 Oct`. */
export function chatWhen(ms: number, now: number): string {
  if (isSameDay(ms, now)) return format(ms, 'HH:mm');
  if (differenceInCalendarDays(now, ms) < 7) return format(ms, 'EEE');
  return format(ms, 'd MMM');
}

/** The open approvals of the agents behind a card's items. */
export function cardApprovals(card: Pick<WorkbenchCard, 'roundUpId' | 'items'>, approvals: readonly PendingApproval[]): PendingApproval[] {
  const agents = new Set(card.items.flatMap((i) => (i.agentId ? [i.agentId] : [])));
  return approvals.filter((a) => a.roundUpId === card.roundUpId && agents.has(a.sessionId));
}

/**
 * The card's callout: the orchestrator's own, or, while its agents wait on approvals it hasn't
 * called out, "2 agents need approval: <the first ask>".
 */
export function calloutOf(card: Pick<WorkbenchCard, 'callout' | 'needsYou'>, approvals: readonly PendingApproval[]): string | undefined {
  if (card.callout) return card.callout;
  if (!card.needsYou) return undefined;
  const agents = new Set(approvals.map((a) => a.sessionId)).size;
  const first = [...approvals].sort((a, b) => a.ts.localeCompare(b.ts))[0];
  if (!agents || !first) return `${card.needsYou} approval${card.needsYou === 1 ? '' : 's'} waiting on you`;
  return `${agents} agent${agents === 1 ? ' needs' : 's need'} approval: ${first.title || first.tool}`;
}

export type PrimaryAction = 'answer' | 'merge' | 'review';

/** The card's one button: answer what waits on the person, else merge what is ready, else review. */
export function primaryAction(card: Pick<WorkbenchCard, 'needsYou' | 'callout' | 'stage' | 'items'>): PrimaryAction | undefined {
  if (card.needsYou > 0 || card.callout) return 'answer';
  if (card.stage === 'done') return undefined;
  if (card.stage === 'ready') return 'merge';
  if (card.stage === 'review' || card.items.some((i) => i.status === 'review' || i.status === 'approved')) return 'review';
  return undefined;
}

export const PRIMARY_LABEL: Record<PrimaryAction, string> = { answer: 'Answer', merge: 'Merge', review: 'Review with Kelpie' };

/**
 * Whether a card shows on the board: not removed by the person, and not done for over a day. The
 * daemon leaves those out already; this keeps a card from staying once its day is up.
 */
export const onBoard = (card: Pick<WorkbenchCard, 'archived' | 'stage' | 'updatedAt' | 'doneAt'>, now: number) =>
  // A done card should always have `doneAt`; without one, its last change stands in.
  !card.archived && !(card.stage === 'done' && now - (card.doneAt ?? card.updatedAt) > DONE_FOR);

/** The board's cards by column, newest change first in each. */
export function columns(cards: readonly WorkbenchCard[], now: number): Record<Stage, WorkbenchCard[]> {
  const out = Object.fromEntries(STAGES.map((s) => [s.stage, [] as WorkbenchCard[]])) as Record<Stage, WorkbenchCard[]>;
  for (const c of cards) if (onBoard(c, now)) out[c.stage]?.push(c);
  for (const list of Object.values(out)) list.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  return out;
}

/** Everything on the board waiting on the person, for the sidebar. */
export const needsYouTotal = (cards: readonly WorkbenchCard[] | undefined, now: number) =>
  (cards ?? []).reduce((n, c) => n + (onBoard(c, now) ? c.needsYou : 0), 0);

/** The list with `card` in it, as the `card` event sends it; a removed card leaves. */
export const upsertCard = (list: WorkbenchCard[] = [], card: WorkbenchCard) =>
  card.archived ? list.filter((c) => c.id !== card.id) : [card, ...list.filter((c) => c.id !== card.id)];

export const dropCard = (list: WorkbenchCard[] | undefined, id: string) => list?.filter((c) => c.id !== id);

/** The turn "Review with Kelpie" sends to the card's round-up. */
export const reviewTurn = (card: Pick<WorkbenchCard, 'id' | 'title'>) =>
  `Walk me through reviewing “${card.title}” (${workbenchPath(card.id)}): what changed, what I should check first, and anything you're unsure of.`;

/** What an item's agent says it is on, as its row shows it: focus, the first claims, and a blocker. */
export function entryOf(item: Pick<WorkbenchItem, 'entry'>, shown = 2): { focus?: string; claims: string[]; more: number; blocker?: string } | undefined {
  const e = item.entry;
  if (!e || (!e.focus && !e.claims.length && !e.blocker && !e.progress)) return undefined;
  const focus = e.focus ?? e.progress;
  return { ...(focus ? { focus } : {}), claims: e.claims.slice(0, shown), more: Math.max(0, e.claims.length - shown), ...(e.blocker ? { blocker: e.blocker } : {}) };
}

/** Who wrote a note, as the board names them: the person is "You", an orchestrator "Kelpie". */
export const noteFrom = (n: Pick<WorkbenchNote, 'from'>) => (n.from.kind === 'person' ? 'You' : n.from.kind === 'orchestrator' ? 'Kelpie' : n.from.title);

/** Whom a note is for, if anyone: "Kelpie" for an orchestrator. */
export const noteTo = (n: Pick<WorkbenchNote, 'to'>) => (n.to ? (n.to.title === 'Orchestrator' ? 'Kelpie' : n.to.title) : undefined);

/**
 * Where a note to someone stands: handed over (with a turn, or as they read the board; whether they
 * acted on it is theirs to say), or waiting for their next turn. Nothing for a note to everyone.
 */
export const noteState = (n: Pick<WorkbenchNote, 'to' | 'deliveredAt'>) => (n.to ? (n.deliveredAt ? 'Handed over' : 'Waiting for their next turn') : undefined);

/** The agents a person's note can go to: the card's, once each, in item order. */
export function noteTargets(card: Pick<WorkbenchCard, 'items'>): { id: string; title: string }[] {
  const out = new Map<string, string>();
  for (const i of card.items) if (i.agentId && !out.has(i.agentId)) out.set(i.agentId, i.agentTitle ?? i.title);
  return [...out].map(([id, title]) => ({ id, title }));
}

/** What Merge lands where: the feature branch onto the local base branch (`landsOn`), never pushed. */
export function landing(card: Pick<WorkbenchCard, 'branch' | 'base' | 'landsOn'>): { from?: string; into: string } {
  return { ...(card.branch ? { from: card.branch } : {}), into: card.landsOn ?? card.base ?? 'base' };
}
