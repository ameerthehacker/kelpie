import { describe, expect, it } from 'vitest';
import type { WorkbenchCard, WorkbenchItem } from '@kelpie/protocol';
import type { PendingApproval } from '../src/lib/approvals.js';
import {
  calloutOf,
  cardApprovals,
  chatWhen,
  columns,
  DONE_FOR,
  dropCard,
  footer,
  needsYouTotal,
  onBoard,
  pillOf,
  primaryAction,
  tally,
  topItems,
  upsertCard,
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
});

describe('the board', () => {
  it('drops removed cards and done ones after a day', () => {
    expect(onBoard(card({}), NOW)).toBe(true);
    expect(onBoard(card({ archived: true }), NOW)).toBe(false);
    expect(onBoard(card({ stage: 'done', updatedAt: NOW - DONE_FOR + MIN }), NOW)).toBe(true);
    expect(onBoard(card({ stage: 'done', updatedAt: NOW - DONE_FOR - MIN }), NOW)).toBe(false);
    // Only done cards age off.
    expect(onBoard(card({ stage: 'review', updatedAt: NOW - 30 * DONE_FOR }), NOW)).toBe(true);
  });

  it('puts cards in their columns, newest first', () => {
    const cards = [
      card({ id: 'a', stage: 'blocked', updatedAt: NOW - 5 * MIN }),
      card({ id: 'b', stage: 'blocked', updatedAt: NOW - MIN }),
      card({ id: 'c', stage: 'ready' }),
      card({ id: 'old', stage: 'done', updatedAt: NOW - 2 * DONE_FOR }),
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
