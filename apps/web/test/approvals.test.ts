import { describe, expect, it } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import { approvalsSummary, broaderRule, canRemember, focusAfter, groupApprovals, pendingQuestions, questionKey, shownQuestion, type PendingApproval } from '../src/lib/approvals.js';
import { buildChat, type PlanView } from '../src/lib/chat.js';

const ask = (over: Partial<PendingApproval>): PendingApproval => ({
  roundUpId: 'r',
  sessionId: 'a1',
  agentTitle: 'Checkout API',
  requestId: Math.random().toString(36),
  tool: 'Bash',
  title: 'pnpm install',
  input: { command: 'pnpm install' },
  rule: 'Bash(pnpm install)',
  ts: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('approvals', () => {
  it('offers "Allow for round-up" only when an agent asks, never for the orchestrator’s own commands alone', () => {
    const [agent] = groupApprovals([ask({})]);
    const [own] = groupApprovals([ask({ sessionId: 'r', agentTitle: 'Round-up' })]);
    const [both] = groupApprovals([ask({ sessionId: 'r', agentTitle: 'Round-up' }), ask({})]);
    const [ruleless] = groupApprovals([ask({ rule: undefined })]);
    expect([agent, own, both, ruleless].map((g) => canRemember(g!))).toEqual([true, false, true, false]);
  });

  it('groups the same ask from many agents into one row, oldest first, and leaves plans to the chat', () => {
    const items = [
      ask({ sessionId: 'a2', agentTitle: 'Billing', ts: '2026-01-01T00:00:02.000Z' }),
      ask({ sessionId: 'a1', agentTitle: 'Checkout API', ts: '2026-01-01T00:00:01.000Z' }),
      ask({ sessionId: 'a3', agentTitle: 'Search', title: 'curl example.com', rule: undefined, tool: 'Bash', ts: '2026-01-01T00:00:03.000Z' }),
      ask({ sessionId: 'a1', agentTitle: 'Checkout API', ts: '2026-01-01T00:00:04.000Z' }),
      ask({ sessionId: 'r', agentTitle: 'Round-up', tool: 'ExitPlanMode', title: 'Approve the plan', rule: undefined }),
    ];
    const groups = groupApprovals(items);
    expect(groups.map((g) => [g.label, g.items.length, g.agents])).toEqual([
      ['pnpm install', 3, ['Checkout API', 'Billing']],
      ['curl example.com', 1, ['Search']],
    ]);
    expect(approvalsSummary(items)).toBe('4 approvals from 3 agents');
  });

  it('never puts different commands in one row, even under one broad rule, and says what that rule allows', () => {
    const groups = groupApprovals([
      ask({ title: 'npm run test', rule: 'Bash(npm run:*)', ts: '2026-01-01T00:00:01.000Z' }),
      ask({ sessionId: 'a2', title: 'npm run publish', rule: 'Bash(npm run:*)', ts: '2026-01-01T00:00:02.000Z' }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['npm run test', 'npm run publish']);
    expect(broaderRule(groups[0]!)).toBe('Bash(npm run:*)');
    expect(broaderRule(groupApprovals([ask({})])[0]!)).toBeUndefined();
  });

  it('queues questions on their own, oldest first, never grouped with the asks', () => {
    const questions = [{ question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] }];
    const q = (over: Partial<PendingApproval>) => ask({ tool: 'AskUserQuestion', title: 'Which color?', rule: undefined, questions, ...over });
    const items = [q({ sessionId: 'a2', ts: '2026-01-01T00:00:02.000Z' }), ask({}), q({ sessionId: 'a3', ts: '2026-01-01T00:00:01.000Z' })];
    expect(groupApprovals(items).map((g) => g.tool)).toEqual(['Bash']);
    expect(pendingQuestions(items).map((x) => x.sessionId)).toEqual(['a3', 'a2']);
    expect(approvalsSummary(items)).toBe('1 approval and 2 questions from 3 agents');
    expect(approvalsSummary([q({})])).toBe('1 question');
  });

  it('shows the question the person paged to while it waits, else the oldest', () => {
    const qs = [ask({ sessionId: 'a1', requestId: 'q1' }), ask({ sessionId: 'a2', requestId: 'q2' }), ask({ sessionId: 'a3', requestId: 'q3' })];
    expect(questionKey(qs[1]!)).toBe('a2:q2');
    expect(shownQuestion(qs, undefined)).toBe(0);
    expect(shownQuestion(qs, 'a3:q3')).toBe(2);
    // Answered (here or elsewhere): back to the oldest left.
    expect(shownQuestion(qs, 'a9:q9')).toBe(0);
    expect(shownQuestion([], 'a1:q1')).toBe(0);
  });

  it('hands the keyboard on when the question that had it leaves the queue', () => {
    const qs = [ask({ sessionId: 'a1', requestId: 'q1' }), ask({ sessionId: 'a2', requestId: 'q2' })];
    // Still waiting, or nothing had the keyboard: leave it be.
    expect(focusAfter(qs, 'a1:q1', 0, 0)).toBeUndefined();
    expect(focusAfter(qs, undefined, 0, 0)).toBeUndefined();
    // Gone: the question now shown takes it; with none left, the approvals; with nothing left, nowhere.
    expect(focusAfter(qs, 'a0:q0', 1, 0)).toEqual({ question: 'a2:q2' });
    expect(focusAfter([], 'a1:q1', 0, 2)).toBe('approvals');
    expect(focusAfter([], 'a1:q1', 0, 0)).toBe('none');
  });

  it('keeps different round-ups’ asks apart', () => {
    expect(groupApprovals([ask({ roundUpId: 'r1' }), ask({ roundUpId: 'r2' })])).toHaveLength(2);
  });

  it('shows a plan put to the person in the chat, and what became of it', () => {
    const base = { runId: 'x', ts: '2026-01-01T00:00:00.000Z', harness: 'claude-code' as const };
    const ev = (seq: number, kind: string, data: unknown) => ({ ...base, id: `x:${seq}`, seq, kind, data }) as KelpieEvent;
    const plans = (events: KelpieEvent[]) => buildChat(events).flatMap((i) => (i.role === 'assistant' ? i.parts.filter((p): p is PlanView => p.type === 'plan') : []));
    const asked = [
      ev(0, 'permission.requested', { requestId: 'p1', tool: 'ExitPlanMode', title: 'Approve the plan', input: {}, plan: '1. Add sub' }),
      ev(1, 'permission.requested', { requestId: 'b1', tool: 'Bash', title: 'ls', input: {} }),
    ];
    expect(plans(asked)).toEqual([{ type: 'plan', requestId: 'p1', plan: '1. Add sub', state: 'open', ts: base.ts }]);
    expect(plans([...asked, ev(2, 'permission.resolved', { requestId: 'p1', decision: 'deny', by: 'person', message: 'Add a test' })])[0]).toMatchObject({ state: 'declined', message: 'Add a test' });
    expect(plans([...asked, ev(2, 'permission.resolved', { requestId: 'p1', decision: 'allow', by: 'person' })])[0]!.state).toBe('approved');
    expect(plans([...asked, ev(2, 'permission.resolved', { requestId: 'p1', decision: 'deny', by: 'expired' })])[0]!.state).toBe('expired');
  });
});
