import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import { ClaudeCodeParser } from '@kelpie/adapters';
import { byAttention, elapsed, liveLog, planProgress, type AgentSummary } from '../src/lib/agents.js';

const FIXTURES = join(import.meta.dirname, '../../../packages/adapters/fixtures/claude-code');

function events(name: string): KelpieEvent[] {
  const parser = new ClaudeCodeParser({ runId: 'r', now: () => '2026-01-01T10:32:00.000Z' });
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l, i) => parser.parse(JSON.parse(l), i + 1));
}

describe('liveLog', () => {
  it('lists an agent’s own steps with edit line counts, and leaves out its todo calls', () => {
    const log = liveLog(events('edit-bash'));
    expect(log.map((l) => l.kind)).toEqual(['you', 'read', 'bash', 'read', 'edit', 'edit', 'bash', 'say', 'done']);
    expect(log.find((l) => l.kind === 'edit')).toMatchObject({ text: 'src/math.js', delta: { added: 4, removed: 0 } });
    expect(liveLog(events('todos')).map((l) => l.kind)).toEqual(['you', 'bash', 'say', 'say', 'done']); // no TaskCreate/TaskUpdate lines
  });

  it('shows failures and skips what its own sub-agents did', () => {
    expect(liveLog(events('bash-fail')).map((l) => l.kind)).toContain('fail');
    expect(liveLog(events('subagent')).some((l) => l.text === 'src/math.js')).toBe(false);
  });
});

describe('agent pane helpers', () => {
  const agent = (status: AgentSummary['status'], createdAt = 0): AgentSummary =>
    ({ id: status, parentId: 'p', title: status, harness: 'claude-code', writes: false, status, now: '', todos: [], createdAt, updatedAt: 90_000 }) as AgentSummary;

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
      ({ id: status, parentId: 'p', title: status, harness: 'claude-code', writes: false, status, now: '', todos, createdAt: 0, updatedAt: 0 }) as AgentSummary;
    expect(planProgress([agent('done', [todo('a', 'completed'), todo('b', 'completed')]), agent('working', [todo('c', 'completed'), todo('d', 'in_progress'), todo('e', 'pending')]), agent('failed', [])])).toEqual({
      agents: 3,
      agentsDone: 1,
      steps: 5,
      stepsDone: 3,
    });
  });
});
