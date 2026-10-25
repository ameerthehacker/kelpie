import { differenceInCalendarDays, format, isSameDay } from 'date-fns';
import type { ItemStatus, Stage, WorkbenchCard, WorkbenchItem } from '@kelpie/protocol';
import type { PendingApproval } from './approvals.js';

export const WORKBENCH_ROUTE = '/workbench/:cardId';
export const workbenchPath = (cardId?: string) => (cardId ? `/workbench/${encodeURIComponent(cardId)}` : '/workbench');

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

/** How long a done card stays on the board. */
export const DONE_FOR = 24 * 60 * 60_000;

/** Whether a card shows on the board: not removed by the person, and not done for over a day. */
export const onBoard = (card: Pick<WorkbenchCard, 'archived' | 'stage' | 'updatedAt'>, now: number) =>
  !card.archived && !(card.stage === 'done' && now - card.updatedAt > DONE_FOR);

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
