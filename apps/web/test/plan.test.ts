import { describe, expect, it } from 'vitest';
import type { AgentSummary } from '../src/lib/agents.js';
import { nowAsTool, planBar, planGroup, planLabel, planSections } from '../src/lib/plan.js';

let n = 0;
const agent = (status: AgentSummary['status'], extra: Partial<AgentSummary> = {}): AgentSummary => {
  n++;
  return { id: `a${n}`, parentId: 'p', title: `Agent ${n}`, harness: 'claude-code', writes: false, status, now: '', todos: [], createdAt: n, updatedAt: n, ...extra };
};
const todo = (text: string, status: 'completed' | 'in_progress' | 'pending', activeText?: string) => ({ id: text, text, status, ...(activeText ? { activeText } : {}) });

describe('planGroup', () => {
  it('keeps a finished agent whose branch waits to be mustered out of done', () => {
    expect(planGroup(agent('done', { branch: 'b', deliver: 'muster', worktree: 'active' }))).toBe('to-merge');
    expect(planGroup(agent('done', { branch: 'b', worktree: 'removed' }))).toBe('to-merge');
  });

  it('counts mustered, standalone, read-only and Muster agents as done', () => {
    expect(planGroup(agent('done', { branch: 'b', deliver: 'muster', worktree: 'mustered' }))).toBe('done');
    expect(planGroup(agent('done', { branch: 'b', deliver: 'standalone', worktree: 'active' }))).toBe('done');
    expect(planGroup(agent('done'))).toBe('done');
    expect(planGroup(agent('done', { kind: 'muster', branch: 'b', worktree: 'active' }))).toBe('done');
  });

  it('maps live statuses', () => {
    expect([agent('needs-approval'), agent('failed'), agent('working'), agent('stopped'), agent('idle')].map(planGroup)).toEqual(['needs-you', 'failed', 'working', 'stopped', 'stopped']);
  });
});

describe('planSections', () => {
  it('puts active agents first by urgency and folds the done ones away', () => {
    const done = agent('done');
    const working = agent('working');
    const toMerge = agent('done', { branch: 'b', worktree: 'active' });
    const asking = agent('needs-approval');
    const failed = agent('failed');
    const { active, done: finished } = planSections([done, working, toMerge, asking, failed]);
    expect(active).toEqual([asking, failed, working, toMerge]);
    expect(finished).toEqual([done]);
  });
});

describe('nowAsTool', () => {
  it('turns a tool call into plain words, never the raw command', () => {
    expect(nowAsTool('Bash sed -n 820,890p packages/daemon/src/orchestrator.ts')).toBe('Running a command');
    expect(nowAsTool('Read packages/daemon/src/orchestrator.ts')).toBe('Reading orchestrator.ts');
    expect(nowAsTool('Edit apps/web/src/lib/plan.ts')).toBe('Editing plan.ts');
    expect(nowAsTool('Grep useUsage in apps/web')).toBe('Searching the repo');
    expect(nowAsTool('WebFetch https://example.com/docs')).toBe('Reading example.com');
    expect(nowAsTool('mcp__kelpie__spawn_agent kelpie/spawn_agent')).toBe('Starting an agent');
    expect(nowAsTool('ExitPlanMode ExitPlanMode')).toBe('Writing up a plan');
  });

  it('leaves anything that is not a tool call alone', () => {
    expect(nowAsTool('Looking at the notifications code now.')).toBeUndefined();
    expect(nowAsTool('Failed: boom')).toBeUndefined();
    expect(nowAsTool('')).toBeUndefined();
  });
});

describe('planLabel', () => {
  it('prefers the current todo, then the tool in plain words', () => {
    expect(planLabel(agent('working', { now: 'Bash rm -rf x', todos: [todo('a', 'completed'), todo('Wire sound', 'in_progress', 'Wiring sound')] }))).toBe('Wiring sound');
    expect(planLabel(agent('working', { now: 'Bash rm -rf x', todos: [todo('Wire sound', 'in_progress')] }))).toBe('Wire sound');
    expect(planLabel(agent('working', { now: 'Bash rm -rf x' }))).toBe('Running a command');
    expect(planLabel(agent('working', { now: 'Thinking out loud' }))).toBe('Working');
  });

  it('says what the person is asked for, and where finished work stands', () => {
    const plan = agent('needs-approval');
    expect(planLabel(plan, { plans: new Set([plan.id]) })).toBe('Plan to review');
    expect(planLabel(agent('needs-approval'))).toBe('Needs your approval');
    expect(planLabel(agent('done', { branch: 'b', worktree: 'active' }))).toBe('Ready to merge');
    expect(planLabel(agent('done', { branch: 'b', worktree: 'mustered' }))).toBe('Merged');
    expect(planLabel(agent('done', { branch: 'b', deliver: 'standalone' }))).toBe('Done · standalone branch');
    expect(planLabel(agent('done'))).toBe('Done');
  });
});

describe('planBar', () => {
  it('gives a dot only to agents that need tracking, capped, and counts the rest', () => {
    const working = Array.from({ length: 6 }, () => agent('working'));
    const failed = agent('failed');
    const asking = agent('needs-approval', { title: 'Fix: notifications' });
    const finished = Array.from({ length: 11 }, () => agent('done'));
    const toMerge = agent('done', { branch: 'b', worktree: 'active' });
    const bar = planBar([...working, ...finished, failed, toMerge, asking]);
    expect(bar.dots).toEqual([asking, failed, ...working.slice(0, 3)]);
    expect(bar.more).toBe(3);
    expect(bar.text).toBe('Fix: notifications: Needs your approval');
    expect(bar.counts).toEqual(['1 to merge', '11 done']);
  });

  it('follows a working agent ahead of a failed one', () => {
    const bar = planBar([agent('failed'), agent('working', { title: 'Sound', todos: [todo('Wire sound', 'in_progress')] })]);
    expect(bar.text).toBe('Sound: Wire sound');
    expect(bar.counts).toEqual([]);
  });

  it('is calm when nothing is moving', () => {
    expect(planBar(Array.from({ length: 22 }, () => agent('done')))).toEqual({ dots: [], more: 0, text: 'All 22 agents done', counts: [] });
    expect(planBar([agent('done'), agent('done', { branch: 'b', worktree: 'active' })]).text).toBe('All 2 agents finished · 1 ready to merge');
    expect(planBar([agent('done'), agent('stopped')]).text).toBe('1/2 agents finished · 1 stopped');
  });
});
