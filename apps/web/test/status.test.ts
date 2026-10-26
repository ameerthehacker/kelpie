import { describe, expect, it } from 'vitest';
import type { AgentSummary } from '../src/lib/agents.js';
import { planBar } from '../src/lib/plan.js';
import type { RoundUp } from '../src/lib/round-ups.js';
import { groupCounts, roundUpStatus, sessionStatus } from '../src/lib/status.js';

const r = (over: Partial<RoundUp>): RoundUp => ({ id: 'x', title: '', cwd: '/r', createdAt: 0, updatedAt: 100, busy: false, mode: 'auto', ...over });

describe('round-up status', () => {
  const top = r({ id: 'top', lastTurn: 'completed' });
  // Sub-agents last moved before Kelpie did (it has had a turn since) unless they say otherwise.
  const sub = (over: Partial<RoundUp>) => r({ id: 's', parentId: 'top', lastTurn: 'completed', updatedAt: 50, ...over });

  it('has none until the round-up has run', () => {
    expect(roundUpStatus(r({ id: 'top' }), [], [])).toBeUndefined();
    expect(roundUpStatus(top, [], [])).toBe('done');
    expect(roundUpStatus(top, [sub({})], [])).toBe('done');
  });

  it('is working while Kelpie or any of its sub-agents is', () => {
    expect(roundUpStatus(r({ id: 'top', busy: true }), [], [])).toBe('working');
    expect(roundUpStatus(top, [sub({ busy: true })], [])).toBe('working');
    // Another round-up's agents don't count.
    expect(roundUpStatus(top, [sub({ parentId: 'other', busy: true })], [])).toBe('done');
  });

  it('puts anything waiting on the person first', () => {
    expect(roundUpStatus(r({ id: 'top', busy: true }), [sub({ busy: true })], [{ roundUpId: 'top' }])).toBe('needs-you');
    expect(roundUpStatus(top, [sub({ lastTurn: 'failed', updatedAt: 200 })], [{ roundUpId: 'top' }])).toBe('needs-you');
    expect(roundUpStatus(top, [], [{ roundUpId: 'other' }])).toBe('done');
    // A question waiting is as much the person's as an approval.
    expect(roundUpStatus(top, [sub({ busy: true })], [{ roundUpId: 'top', tool: 'AskUserQuestion', questions: [{ question: 'Which?', options: [] }] }] as never)).toBe('needs-you');
  });

  it('shows a failed turn over work, unless that agent is trying again', () => {
    expect(roundUpStatus(r({ id: 'top', lastTurn: 'failed' }), [], [])).toBe('failed');
    expect(roundUpStatus(r({ id: 'top', busy: true }), [sub({ lastTurn: 'failed', updatedAt: 200 })], [])).toBe('failed');
    expect(roundUpStatus(top, [sub({ busy: true, lastTurn: 'failed', updatedAt: 200 })], [])).toBe('working');
  });

  it('lets go of a sub-agent’s failure once Kelpie has had a turn since', () => {
    // Abandoned: Kelpie moved on (told the person, or chose not to retry). A grey ring, not red for ever.
    expect(roundUpStatus(top, [sub({ lastTurn: 'failed', updatedAt: 50 })], [])).toBe('stopped');
    expect(roundUpStatus(top, [sub({ lastTurn: 'failed', updatedAt: 100 })], [])).toBe('stopped');
    // Kelpie's own failure always counts.
    expect(roundUpStatus(r({ id: 'top', lastTurn: 'failed', updatedAt: 500 }), [sub({ updatedAt: 50 })], [])).toBe('failed');
  });

  it('shows a stopped turn as stopped, not done', () => {
    expect(roundUpStatus(r({ id: 'top', lastTurn: 'interrupted' }), [], [])).toBe('stopped');
    expect(roundUpStatus(top, [sub({ lastTurn: 'interrupted' })], [])).toBe('stopped');
    // A sub-agent that has not run yet is idle, as its summary says.
    expect(roundUpStatus(top, [sub({ lastTurn: undefined })], [])).toBe('stopped');
  });

  it('is ready to merge while finished branches wait to be mustered', () => {
    expect(roundUpStatus(top, [sub({ branch: 'k/a', deliver: 'muster', worktree: 'active' }), sub({ id: 't' })], [])).toBe('to-merge');
    expect(roundUpStatus(top, [sub({ branch: 'k/a', deliver: 'muster', worktree: 'mustered' })], [])).toBe('done');
    expect(roundUpStatus(top, [sub({ branch: 'k/a', deliver: 'standalone', worktree: 'active' })], [])).toBe('done');
    expect(roundUpStatus(top, [sub({ kind: 'muster', branch: 'k/home', worktree: 'active' })], [])).toBe('done');
  });

  it('agrees with the Plan bar on the same agents', () => {
    const subs = [
      sub({ id: 'a', branch: 'k/a', worktree: 'active' }),
      sub({ id: 'b', branch: 'k/b', worktree: 'active' }),
      sub({ id: 'c', branch: 'k/c', worktree: 'mustered' }),
      sub({ id: 'd', lastTurn: 'failed', updatedAt: 60 }),
    ];
    // The same agents as the pane lists them.
    const agents = subs.map((s): AgentSummary => ({
      id: s.id,
      parentId: 'top',
      title: s.id,
      harness: 'claude-code',
      writes: true,
      browser: false,
      status: sessionStatus(s, false)!,
      now: '',
      todos: [],
      ...(s.branch ? { branch: s.branch } : {}),
      ...(s.worktree ? { worktree: s.worktree } : {}),
      createdAt: 0,
      updatedAt: s.updatedAt,
    }));
    const bar = planBar(agents, { settledAt: top.updatedAt });
    expect(roundUpStatus(top, subs, [])).toBe('to-merge');
    expect(bar.dots).toEqual([]);
    expect(bar.text).toBe('3/4 agents finished · 2 ready to merge · 1 stopped');
  });
});

describe('sessionStatus', () => {
  it('works a session out as the daemon works out an agent', () => {
    expect(sessionStatus({ busy: true }, true)).toBe('needs-approval');
    expect(sessionStatus({ busy: true, lastTurn: 'failed' }, false)).toBe('working');
    expect(sessionStatus({ busy: false, lastTurn: 'completed' }, false)).toBe('done');
    expect(sessionStatus({ busy: false, lastTurn: 'failed' }, false)).toBe('failed');
    expect(sessionStatus({ busy: false, lastTurn: 'interrupted' }, false)).toBe('stopped');
    expect(sessionStatus({ busy: false }, false)).toBeUndefined();
  });
});

describe('groupCounts', () => {
  it('counts each group in one vocabulary, most urgent first', () => {
    expect(groupCounts(['working', 'needs-you', 'working', 'done', 'to-merge'])).toEqual(['1 needs you', '2 working', '1 ready to merge', '1 done']);
    expect(groupCounts(['needs-you', 'needs-you'], ['needs-you'])).toEqual(['2 need you']);
    expect(groupCounts([])).toEqual([]);
  });
});
