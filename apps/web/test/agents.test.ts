import { describe, expect, it } from 'vitest';
import { byAttention, elapsed, planProgress, type AgentSummary } from '../src/lib/agents.js';

describe('agent pane helpers', () => {
  const agent = (status: AgentSummary['status'], createdAt = 0): AgentSummary =>
    ({ id: status, parentId: 'p', title: status, harness: 'claude-code', writes: false, browser: false, status, now: '', todos: [], createdAt, updatedAt: 90_000 }) as AgentSummary;

  it('puts what needs attention first', () => {
    expect([agent('done'), agent('working'), agent('failed')].sort(byAttention).map((a) => a.status)).toEqual(['failed', 'working', 'done']);
  });

  it('counts a working agent up to now, and a finished one up to its last change', () => {
    expect(elapsed(agent('working'), 8 * 60_000 + 5_000)).toBe('8m');
    expect(elapsed(agent('done'), 10 * 3_600_000)).toBe('1m');
    expect(elapsed(agent('working'), 65 * 60_000)).toBe('1h 5m');
  });
});

describe('planProgress', () => {
  it('counts finished agents and ticked-off todos across the round-up', () => {
    const todo = (id: string, status: 'completed' | 'in_progress' | 'pending') => ({ id, text: id, status });
    const agent = (status: AgentSummary['status'], todos: ReturnType<typeof todo>[]) =>
      ({ id: status, parentId: 'p', title: status, harness: 'claude-code', writes: false, browser: false, status, now: '', todos, createdAt: 0, updatedAt: 0 }) as AgentSummary;
    expect(planProgress([agent('done', [todo('a', 'completed'), todo('b', 'completed')]), agent('working', [todo('c', 'completed'), todo('d', 'in_progress'), todo('e', 'pending')]), agent('failed', [])])).toEqual({
      agents: 3,
      agentsDone: 1,
      steps: 5,
      stepsDone: 3,
    });
  });
});
