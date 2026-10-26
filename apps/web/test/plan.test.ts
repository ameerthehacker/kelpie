import { describe, expect, it } from 'vitest';
import type { ToolCategory } from '@kelpie/protocol';
import type { AgentSummary } from '../src/lib/agents.js';
import { nowAsTool, planBar, planLabel, planSections } from '../src/lib/plan.js';
import { planGroup } from '../src/lib/status.js';

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
    expect([agent('needs-approval'), agent('failed'), agent('working'), agent('stopped'), agent('idle')].map((a) => planGroup(a))).toEqual(['needs-you', 'failed', 'working', 'stopped', 'stopped']);
  });

  it('calms a failure the orchestrator has had a turn since', () => {
    const failed = agent('failed', { updatedAt: 100 });
    expect(planGroup(failed, 99)).toBe('failed');
    expect(planGroup(failed, 100)).toBe('stopped');
    expect(planGroup(failed, 200)).toBe('stopped');
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
  const tool = (now: string, name: string, category: ToolCategory) => ({ now, nowTool: { name, category } });
  it('puts the daemon\'s tool in plain words, never the raw command', () => {
    expect(nowAsTool(tool('Bash sed -n 820,890p packages/daemon/src/orchestrator.ts', 'Bash', 'bash'))).toBe('Running a command');
    expect(nowAsTool(tool('Read packages/daemon/src/orchestrator.ts', 'Read', 'read'))).toBe('Reading orchestrator.ts');
    expect(nowAsTool(tool('Edit apps/web/src/lib/plan.ts', 'Edit', 'edit'))).toBe('Editing plan.ts');
    expect(nowAsTool(tool('Grep useUsage in apps/web', 'Grep', 'search'))).toBe('Searching the repo');
    expect(nowAsTool(tool('WebFetch https://example.com/docs', 'WebFetch', 'web'))).toBe('Reading example.com');
    expect(nowAsTool(tool('mcp__kelpie__spawn_agent kelpie/spawn_agent', 'mcp__kelpie__spawn_agent', 'mcp'))).toBe('Starting an agent');
    expect(nowAsTool(tool('ExitPlanMode ExitPlanMode', 'ExitPlanMode', 'other'))).toBe('Writing up a plan');
  });

  it('is undefined for what the agent said, even when it reads like a tool, and for tools without words', () => {
    expect(nowAsTool({ now: 'Task done.' })).toBeUndefined();
    expect(nowAsTool({ now: 'Edit the README next.' })).toBeUndefined();
    expect(nowAsTool({ now: 'Failed: boom' })).toBeUndefined();
    expect(nowAsTool({ now: '' })).toBeUndefined();
    expect(nowAsTool(tool('AskUserQuestion AskUserQuestion', 'AskUserQuestion', 'other'))).toBeUndefined();
  });
});

describe('planLabel', () => {
  it('prefers the current todo, then the tool in plain words', () => {
    const bash = { now: 'Bash rm -rf x', nowTool: { name: 'Bash', category: 'bash' as const } };
    expect(planLabel(agent('working', { ...bash, todos: [todo('a', 'completed'), todo('Wire sound', 'in_progress', 'Wiring sound')] }))).toBe('Wiring sound');
    expect(planLabel(agent('working', { ...bash, todos: [todo('Wire sound', 'in_progress')] }))).toBe('Wire sound');
    expect(planLabel(agent('working', bash))).toBe('Running a command');
    expect(planLabel(agent('working', { now: 'Thinking out loud' }))).toBe('Working');
    expect(planLabel(agent('working', { now: 'Task done.' }))).toBe('Working');
  });

  it('says what the person is asked for, and where finished work stands', () => {
    const plan = agent('needs-approval');
    expect(planLabel(plan, { plans: new Set([plan.id]) })).toBe('Plan to review');
    expect(planLabel(agent('needs-approval'))).toBe('Needs your approval');
    const asking = agent('needs-approval');
    expect(planLabel(asking, { questions: new Set([asking.id]) })).toBe('Has a question');
    expect(planLabel(agent('idle'))).toBe('Stopped');
    expect(planLabel(agent('failed', { updatedAt: 1 }), { settledAt: 2 })).toBe('Failed');
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
    expect(bar.dots.map((d) => d.agent)).toEqual([asking, failed, ...working.slice(0, 3)]);
    expect(bar.dots.map((d) => d.group)).toEqual(['needs-you', 'failed', 'working', 'working', 'working']);
    expect(bar.more).toBe(3);
    expect(bar.text).toBe('Fix: notifications: Needs your approval');
    expect(bar.counts).toEqual(['1 ready to merge', '11 done']);
    // Read out as what the dots stand for, the ones past the cap too.
    expect(bar.label).toBe('1 needs you, 1 failed, 6 working');
  });

  it('follows a working agent ahead of a failed one', () => {
    const bar = planBar([agent('failed'), agent('working', { title: 'Sound', todos: [todo('Wire sound', 'in_progress')] })]);
    expect(bar.text).toBe('Sound: Wire sound');
    expect(bar.counts).toEqual([]);
  });

  it('is calm when nothing is moving', () => {
    expect(planBar(Array.from({ length: 22 }, () => agent('done')))).toEqual({ dots: [], more: 0, text: 'All 22 agents done', counts: [], label: '' });
    expect(planBar([agent('done'), agent('done', { branch: 'b', worktree: 'active' })]).text).toBe('All 2 agents finished · 1 ready to merge');
    expect(planBar([agent('done'), agent('stopped')]).text).toBe('1/2 agents finished · 1 stopped');
  });

  it('drops a failure the orchestrator has moved on from out of the dots', () => {
    const failed = agent('failed', { updatedAt: 10 });
    expect(planBar([failed, agent('done')], { settledAt: 5 }).dots.map((d) => d.group)).toEqual(['failed']);
    expect(planBar([failed, agent('done')], { settledAt: 20 })).toMatchObject({ dots: [], text: '1/2 agents finished · 1 stopped' });
  });
});
