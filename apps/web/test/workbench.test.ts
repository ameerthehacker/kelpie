import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DONE_FOR, type WorkbenchCard, type WorkbenchItem, type WorkbenchNote } from '@kelpie/protocol';
import { HttpError } from '../src/lib/api.js';
import type { PendingApproval } from '../src/lib/approvals.js';
import {
  boardOf,
  calloutOf,
  cardApprovals,
  chatWhen,
  columns,
  createdCard,
  dropCard,
  entryOf,
  landing,
  footer,
  needsYouTotal,
  noteFrom,
  noteState,
  noteTargets,
  noteTo,
  onBoard,
  pillOf,
  primaryAction,
  reviewTurn,
  tally,
  topItems,
  upsertCard,
  WORKBENCH,
  workbenchQuery,
  workbenchStream,
} from '../src/lib/workbench.js';

// A Sunday.
const NOW = new Date('2026-10-25T12:00:00').getTime();
const MIN = 60_000;

const item = (over: Partial<WorkbenchItem>): WorkbenchItem => ({ key: 'k', title: 'Item', status: 'draft', waiting: 0, updatedAt: NOW, ...over });
const card = (over: Partial<WorkbenchCard>): WorkbenchCard => ({
  id: 'c1',
  roundUpId: 'r1',
  title: 'Card',
  chat: 'Chat',
  stage: 'building',
  tickets: [],
  items: [],
  agents: { total: 0, working: 0 },
  needsYou: 0,
  notes: [],
  noteCount: 0,
  archived: false,
  createdAt: NOW - 60 * MIN,
  updatedAt: NOW - MIN,
  ...over,
});
const ask = (over: Partial<PendingApproval>): PendingApproval => ({
  roundUpId: 'r1',
  sessionId: 'a1',
  agentTitle: 'Agent',
  requestId: 'q',
  tool: 'Bash',
  title: 'pnpm install',
  input: {},
  ts: '2026-10-25T11:00:00Z',
  ...over,
});

describe('workbench items', () => {
  it('labels each status', () => {
    expect(pillOf('review').label).toBe('Needs your review');
    expect(pillOf('checks').label).toBe('Checks running');
    expect(pillOf('merged').label).toBe('Merged');
    expect(pillOf('draft').label).toBe('Draft');
  });

  it('shows reviews first, then blocked, then the newest', () => {
    const items = [
      item({ key: 'merged', status: 'merged' }),
      item({ key: 'old-draft', status: 'draft', updatedAt: NOW - 10 * MIN }),
      item({ key: 'new-draft', status: 'draft', updatedAt: NOW }),
      item({ key: 'review', status: 'review', updatedAt: NOW - 99 * MIN }),
      item({ key: 'blocked', status: 'blocked' }),
    ];
    expect(topItems(items, 3).map((i) => i.key)).toEqual(['review', 'blocked', 'new-draft']);
    expect(topItems(items, 10).map((i) => i.key)).toEqual(['review', 'blocked', 'new-draft', 'old-draft', 'merged']);
  });

  it('tallies what the card does not show', () => {
    expect(tally([])).toBe('No pull requests yet');
    expect(tally([item({ key: 'a' }), item({ key: 'b' })])).toBeUndefined();
    const many = [
      ...Array.from({ length: 4 }, (_, i) => item({ key: `r${i}`, status: 'review' })),
      ...Array.from({ length: 3 }, (_, i) => item({ key: `m${i}`, status: 'merged' })),
      item({ key: 'b', status: 'blocked' }),
      item({ key: 'd', status: 'draft' }),
    ];
    // Three reviews shown; one review, the blocked one, the draft and the merged ones are not.
    expect(tally(many)).toBe('+ 6 more · 3 merged · 1 in review · 1 blocked');
    expect(tally([...many.slice(0, 3), item({ key: 'd', status: 'draft' })])).toBe('+ 1 more');
  });
});

describe('workbench cards', () => {
  it('says how the agents are doing', () => {
    expect(footer({ agents: { total: 180, working: 42 }, needsYou: 8 })).toEqual({ agents: '42 of 180 agents working', needsYou: '8 need you' });
    expect(footer({ agents: { total: 1, working: 0 }, needsYou: 0 })).toEqual({ agents: '1 agent · idle', needsYou: undefined });
    expect(footer({ agents: { total: 1, working: 1 }, needsYou: 1 })).toEqual({ agents: '1 agent · working', needsYou: '1 needs you' });
    expect(footer({ agents: { total: 3, working: 0 }, needsYou: 0 }).agents).toBe('3 agents · idle');
    expect(footer({ agents: { total: 0, working: 0 }, needsYou: 0 }).agents).toBe('No agents yet');
  });

  it('dates the chat line', () => {
    expect(chatWhen(new Date('2026-10-25T10:28:00').getTime(), NOW)).toBe('10:28');
    expect(chatWhen(new Date('2026-10-23T09:00:00').getTime(), NOW)).toBe('Fri');
    expect(chatWhen(new Date('2026-10-03T09:00:00').getTime(), NOW)).toBe('3 Oct');
  });

  it("counts only the approvals of the card's own agents", () => {
    const c = card({ items: [item({ key: 'a1', agentId: 'a1' }), item({ key: 'pr' })] });
    const all = [ask({ sessionId: 'a1' }), ask({ sessionId: 'a2' }), ask({ sessionId: 'a1', roundUpId: 'r2' })];
    expect(cardApprovals(c, all)).toEqual([all[0]]);
  });

  it('calls out open approvals the orchestrator has not', () => {
    expect(calloutOf(card({ callout: 'Pick a region' }), [ask({})])).toBe('Pick a region');
    expect(calloutOf(card({}), [])).toBeUndefined();
    const asks = [ask({ sessionId: 'a2', title: 'rm -rf dist', ts: '2026-10-25T11:30:00Z' }), ask({ sessionId: 'a1', ts: '2026-10-25T11:00:00Z' })];
    expect(calloutOf(card({ needsYou: 2 }), asks)).toBe('2 agents need approval: pnpm install');
    expect(calloutOf(card({ needsYou: 1 }), [ask({})])).toBe('1 agent needs approval: pnpm install');
    expect(calloutOf(card({ needsYou: 3 }), [])).toBe('3 approvals waiting on you');
  });

  it('picks the one thing to do', () => {
    expect(primaryAction(card({ needsYou: 1, stage: 'ready' }))).toBe('answer');
    expect(primaryAction(card({ callout: 'Which region?' }))).toBe('answer');
    expect(primaryAction(card({ stage: 'ready' }))).toBe('merge');
    expect(primaryAction(card({ stage: 'review' }))).toBe('review');
    expect(primaryAction(card({ items: [item({ status: 'approved' })] }))).toBe('review');
    expect(primaryAction(card({ items: [item({ status: 'draft' })] }))).toBeUndefined();
    expect(primaryAction(card({ stage: 'done', items: [item({ status: 'review' })] }))).toBeUndefined();
  });

  it('asks for a review with a link to the card', () => {
    expect(reviewTurn(card({ id: 'c 1', title: 'Dark mode' }))).toBe(
      'Walk me through reviewing “Dark mode” (/workbench/c%201): what changed, what I should check first, and anything you\'re unsure of.',
    );
  });
});

describe('the board', () => {
  it('drops removed cards and done ones after a day', () => {
    expect(onBoard(card({}), NOW)).toBe(true);
    expect(onBoard(card({ archived: true }), NOW)).toBe(false);
    expect(onBoard(card({ stage: 'done', doneAt: NOW - DONE_FOR + MIN }), NOW)).toBe(true);
    expect(onBoard(card({ stage: 'done', doneAt: NOW - DONE_FOR - MIN }), NOW)).toBe(false);
    // A later write (an item merged) doesn't keep a done card on the board.
    expect(onBoard(card({ stage: 'done', doneAt: NOW - DONE_FOR - MIN, updatedAt: NOW }), NOW)).toBe(false);
    // Without `doneAt`, its last change stands in.
    expect(onBoard(card({ stage: 'done', updatedAt: NOW - DONE_FOR - MIN }), NOW)).toBe(false);
    // Only done cards age off.
    expect(onBoard(card({ stage: 'review', updatedAt: NOW - 30 * DONE_FOR }), NOW)).toBe(true);
  });

  it('puts cards in their columns, newest first', () => {
    const cards = [
      card({ id: 'a', stage: 'blocked', updatedAt: NOW - 5 * MIN }),
      card({ id: 'b', stage: 'blocked', updatedAt: NOW - MIN }),
      card({ id: 'c', stage: 'ready' }),
      card({ id: 'old', stage: 'done', doneAt: NOW - 2 * DONE_FOR }),
    ];
    const cols = columns(cards, NOW);
    expect(cols.blocked.map((c) => c.id)).toEqual(['b', 'a']);
    expect(cols.ready.map((c) => c.id)).toEqual(['c']);
    expect(cols.done).toEqual([]);
    expect(cols.review).toEqual([]);
  });

  it('adds up what waits on the person across the board', () => {
    expect(needsYouTotal(undefined, NOW)).toBe(0);
    expect(needsYouTotal([card({ needsYou: 2 }), card({ needsYou: 3 }), card({ needsYou: 4, archived: true })], NOW)).toBe(5);
  });

  it('keeps the list current from the stream', () => {
    const list = [card({ id: 'a' }), card({ id: 'b' })];
    expect(upsertCard(list, card({ id: 'b', title: 'New' })).map((c) => [c.id, c.title])).toEqual([
      ['b', 'New'],
      ['a', 'Card'],
    ]);
    expect(upsertCard(list, card({ id: 'a', archived: true })).map((c) => c.id)).toEqual(['b']);
    expect(upsertCard(undefined, card({ id: 'z' })).map((c) => c.id)).toEqual(['z']);
    expect(dropCard(list, 'a')?.map((c) => c.id)).toEqual(['b']);
  });
});

describe('the board from the daemon', () => {
  const msg = (data: unknown) => ({ id: '', event: '', data: JSON.stringify(data) });
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  /** A client whose board is being fetched (by a mounted view, as the sidebar's is), answering `first` then `later`. */
  const fetching = (later: WorkbenchCard[] = []) => {
    const client = new QueryClient();
    const first = deferred<WorkbenchCard[]>();
    const queryFn = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(later);
    const stop = new QueryObserver(client, { queryKey: WORKBENCH, queryFn }).subscribe(() => {});
    return { client, first, queryFn, stop, board: () => client.getQueryData<WorkbenchCard[]>(WORKBENCH)?.map((c) => c.id) };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('keeps the list current from the stream', () => {
    const client = new QueryClient();
    const on = workbenchStream(client);
    on.workbench(msg([card({ id: 'a' }), card({ id: 'b' })]));
    on.card(msg(card({ id: 'c' })));
    on['card-removed'](msg({ id: 'a' }));
    expect(client.getQueryData<WorkbenchCard[]>(WORKBENCH)?.map((c) => c.id)).toEqual(['c', 'b']);
  });

  it('lets the snapshot win over a fetch that answers after it', async () => {
    const { client, first, stop, board } = fetching();
    workbenchStream(client).workbench(msg([card({ id: 'new' })]));
    first.resolve([card({ id: 'stale' })]);
    await settle();
    expect(board()).toEqual(['new']);
    stop();
  });

  it('fetches again when a card changes or goes during a fetch', async () => {
    const { client, first, queryFn, stop, board } = fetching([card({ id: 'b' })]);
    // The first answer predates the removal of `a`; the second has it.
    workbenchStream(client)['card-removed'](msg({ id: 'a' }));
    first.resolve([card({ id: 'a' }), card({ id: 'b' })]);
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(board()).toEqual(['b']);
    stop();
  });
});

describe('a daemon without the Workbench', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gets a calm, empty board, asked for once', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient();
    await client.prefetchQuery(workbenchQuery);
    const state = client.getQueryState(WORKBENCH);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(boardOf(state?.data as WorkbenchCard[] | undefined, state?.error ?? null)).toEqual({ cards: [], unavailable: true });
    // Its snapshot fills the board once the daemon has one.
    workbenchStream(client).workbench({ id: '', event: '', data: JSON.stringify([card({ id: 'a' })]) });
    const after = client.getQueryState(WORKBENCH);
    expect(boardOf(after?.data as WorkbenchCard[] | undefined, after?.error ?? null).cards?.map((c) => c.id)).toEqual(['a']);
  });

  it('still shows other errors', () => {
    expect(workbenchQuery.retry(0, new HttpError('not found', 404))).toBe(false);
    expect(workbenchQuery.retry(0, new HttpError('Internal Server Error', 500))).toBe(true);
    expect(workbenchQuery.retry(1, new HttpError('Internal Server Error', 500))).toBe(false);
    expect(boardOf(undefined, new HttpError('Internal Server Error', 500))).toEqual({ cards: undefined, error: 'Internal Server Error', unavailable: false });
    expect(boardOf([card({})], null).cards).toHaveLength(1);
  });
});

describe('coordination on a card', () => {
  const entry = (over: Partial<NonNullable<WorkbenchItem['entry']>>) => ({ claims: [], updatedAt: NOW, ...over });

  it("shows an agent's focus (or progress), its first claims and a blocker", () => {
    expect(entryOf(item({}))).toBeUndefined();
    expect(entryOf(item({ entry: entry({}) }))).toBeUndefined();
    expect(entryOf(item({ entry: entry({ focus: 'Checkout API', claims: ['a/**', 'b.ts', 'c.ts'], blocker: 'needs the schema' }) }))).toEqual({
      focus: 'Checkout API',
      claims: ['a/**', 'b.ts'],
      more: 1,
      blocker: 'needs the schema',
    });
    expect(entryOf(item({ entry: entry({ progress: 'routes done' }) }))).toEqual({ focus: 'routes done', claims: [], more: 0 });
  });

  it('names who wrote a note, to whom, and whether it has reached them', () => {
    const note = (over: Partial<WorkbenchNote>): WorkbenchNote => ({ id: 1, from: { kind: 'agent', title: 'API' }, body: 'hi', createdAt: NOW, ...over });
    expect(noteFrom(note({}))).toBe('API');
    expect(noteFrom(note({ from: { kind: 'person', title: 'The person' } }))).toBe('You');
    expect(noteFrom(note({ from: { kind: 'orchestrator', title: 'Orchestrator' } }))).toBe('Kelpie');
    expect(noteTo(note({}))).toBeUndefined();
    expect(noteTo(note({ to: { title: 'Orchestrator' } }))).toBe('Kelpie');
    expect(noteTo(note({ to: { title: 'Docs', agentId: 'd' } }))).toBe('Docs');
    expect(noteState(note({}))).toBeUndefined();
    expect(noteState(note({ to: { title: 'Docs' } }))).toBe('Waiting for their next turn');
    expect(noteState(note({ to: { title: 'Docs' }, deliveredAt: NOW }))).toBe('Handed over');
  });

  it("offers the card's agents, once each, as a note's recipients", () => {
    const c = card({
      items: [
        item({ key: 'a', title: 'Checkout API', agentId: 'a', agentTitle: 'API' }),
        item({ key: 'pr', title: 'PR #12', agentId: 'a' }),
        item({ key: 'docs', title: 'Docs' }),
        item({ key: 'b', title: 'UI', agentId: 'b' }),
      ],
    });
    expect(noteTargets(c)).toEqual([
      { id: 'a', title: 'API' },
      { id: 'b', title: 'UI' },
    ]);
  });
});

describe('landing', () => {
  it('lands on the local base branch, never the remote one', () => {
    expect(landing({ branch: 'kelpie/checkout', base: 'origin/main', landsOn: 'main' })).toEqual({ from: 'kelpie/checkout', into: 'main' });
    expect(landing({ base: 'develop' })).toEqual({ into: 'develop' });
    expect(landing({})).toEqual({ into: 'base' });
  });
});

describe('createdCard', () => {
  it('finds the card a create_card call made, even in a cut output', () => {
    expect(createdCard('{\n  "card": "c-1",\n  "link": "/workbench/c-1"\n}')).toBe('c-1');
    expect(createdCard('{ "card": "c-2", "items": [{ "key": "a", "ti')).toBe('c-2');
    expect(createdCard('Unknown round-up')).toBeUndefined();
    expect(createdCard(undefined)).toBeUndefined();
  });
});
