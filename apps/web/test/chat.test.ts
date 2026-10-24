import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import { ClaudeCodeParser } from '@kelpie/adapters';
import { buildChat, latestTodos, type AssistantPart, type ToolView } from '../src/lib/chat.js';

const FIXTURES = join(import.meta.dirname, '../../../packages/adapters/fixtures/claude-code');

function events(name: string): KelpieEvent[] {
  const parser = new ClaudeCodeParser({ runId: 'r', now: () => '2026-01-01T00:00:00.000Z' });
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l, i) => parser.parse(JSON.parse(l), i + 1));
}

const partsOf = (name: string): AssistantPart[] => buildChat(events(name)).flatMap((i) => (i.role === 'assistant' ? i.parts : []));
const toolsOf = (name: string) => partsOf(name).filter((p): p is ToolView => p.type === 'tool');

describe('buildChat', () => {
  it('alternates user turns and assistant replies', () => {
    expect(buildChat(events('multi-turn')).map((i) => (i.role === 'user' ? `user:${i.text.slice(0, 8)}` : `assistant:${i.parts.length}`))).toEqual([
      'user:Remember',
      'assistant:1',
      'user:What wor',
      'assistant:1',
    ]);
  });

  it('shows tools with their outcome and line counts', () => {
    const tools = toolsOf('edit-bash');
    expect(tools.every((t) => t.state === 'done')).toBe(true);
    expect(tools.find((t) => t.name === 'Edit')?.delta).toEqual({ added: 4, removed: 0 });
    expect(toolsOf('bash-fail')[0]).toMatchObject({ state: 'error', output: 'Exit code 3' });
  });

  it('leaves todo lists to the agent pane, not the chat', () => {
    expect(partsOf('todos').some((p) => (p.type as string) === 'todos')).toBe(false);
    expect(toolsOf('todos').some((t) => t.category === 'todo')).toBe(false);
  });

  it('shows agents the orchestrator started as pills, and refusals as such', () => {
    const base = { runId: 'r', ts: '2026-01-01T00:00:00.000Z', harness: 'claude-code' as const };
    const spawn = (callId: string, title: string) =>
      ({ ...base, id: `s-${callId}`, seq: 0, kind: 'tool.started', data: { callId, name: 'mcp__kelpie__spawn_agent', category: 'mcp', title: 'kelpie/spawn_agent', input: { title, task: 'x', writes: true } } }) as KelpieEvent;
    const done = (callId: string, ok: boolean, output: string) =>
      ({ ...base, id: `f-${callId}`, seq: 1, kind: 'tool.finished', data: { callId, name: 'mcp__kelpie__spawn_agent', ok, output, truncated: false } }) as KelpieEvent;
    const parts = buildChat([
      spawn('c1', 'Checkout API'),
      done('c1', true, '{"agentId":"a1","status":"working"}'),
      spawn('c2', 'Receipt email'),
      done('c2', false, 'writing agent "Checkout API" is still working in this repo'),
    ]).flatMap((i) => (i.role === 'assistant' ? i.parts : []));
    expect(parts).toEqual([
      { type: 'spawn', callId: 'c1', title: 'Checkout API', state: 'done', agentId: 'a1' },
      { type: 'spawn', callId: 'c2', title: 'Receipt email', state: 'error', error: 'writing agent "Checkout API" is still working in this repo' },
    ]);
  });

  it('nests sub-agent work under the Agent call', () => {
    const agent = toolsOf('subagent').find((t) => t.category === 'task')!;
    expect(agent.steps).toEqual(['read src/math.js']);
    expect(toolsOf('subagent').map((t) => t.name)).toEqual(['Agent']);
  });

  it('notes an interrupted turn', () => {
    expect(partsOf('interrupt').at(-1)).toEqual({ type: 'notice', tone: 'info', text: 'Interrupted.' });
  });

  it('keeps a tool cut off by a dead process failed after a later run resumes the session', () => {
    const ev = (kind: string, data: unknown) => ({ id: `${kind}-${Math.random()}`, kind, data }) as unknown as KelpieEvent;
    const crashed = [
      ev('tool.started', { callId: 'c1', name: 'Bash', category: 'bash', title: 'sleep 100', input: {} }),
      ev('process.exited', { code: 1, signal: null, stderrTail: '' }),
    ];
    const tool = (es: KelpieEvent[]) => buildChat(es).flatMap((i) => (i.role === 'assistant' ? i.parts : [])).find((p) => p.type === 'tool');
    expect(tool(crashed)).toMatchObject({ state: 'error' });
    expect(tool([...crashed, ...events('plain')])).toMatchObject({ state: 'error' });
  });

  it('shows queued messages as separate user turns before the merged reply', () => {
    expect(buildChat(events('queued')).map((i) => i.role)).toEqual(['user', 'assistant', 'user', 'user', 'assistant']);
  });
});

describe('orchestrator notifications', () => {
  const base = { runId: 'r', ts: '2026-01-01T00:00:00.000Z', harness: 'claude-code' as const };
  const text =
    '<kelpie-notification>\n## Agent "Count A" (a1) is idle: turn completed\nFiles changed: x.ts (+1 -0)\n\n## Outcome\ndone: 4\n\n' +
    '## Agent "Count B" (b1) is idle: turn failed\nError: boom\n\n(no report)\n\nThis message is from Kelpie, not the person. Use read_agent for more detail.\n</kelpie-notification>';
  const agents = [
    { agentId: 'a1', title: 'Count A', status: 'completed', report: '## Outcome\ndone: 4' },
    { agentId: 'b1', title: 'Count B', status: 'failed', report: '', error: 'boom' },
  ];

  it('shows a notification as agent updates, not as the person speaking', () => {
    const items = buildChat([{ ...base, id: 'n', seq: 0, kind: 'message', data: { role: 'user', text, sent: true, source: 'kelpie', agents } }]);
    expect(items).toEqual([{ role: 'assistant', id: 'n', parts: [{ type: 'agents', agents }] }]);
  });

  it('takes reports from the text when the echo leaves them out', () => {
    const slim = agents.map(({ report: _, ...a }) => a);
    const items = buildChat([{ ...base, id: 'n', seq: 0, kind: 'message', data: { role: 'user', text, sent: true, source: 'kelpie', agents: slim } }]);
    expect(items).toEqual([{ role: 'assistant', id: 'n', parts: [{ type: 'agents', agents }] }]);
  });

  it('reads the agents out of notifications logged before echoes carried them', () => {
    const items = buildChat([{ ...base, id: 'n', seq: 0, kind: 'message', data: { role: 'user', text, sent: true } }]);
    expect(items).toEqual([{ role: 'assistant', id: 'n', parts: [{ type: 'agents', agents }] }]);
  });

  it('shows a restart note as one line', () => {
    const note = '<kelpie-notification>\nKelpie restarted while you were working; your turn was cut off.\n</kelpie-notification>';
    const items = buildChat([{ ...base, id: 'n', seq: 0, kind: 'message', data: { role: 'user', text: note, sent: true, source: 'kelpie' } }]);
    expect(items[0]).toEqual({ role: 'assistant', id: 'n', parts: [{ type: 'notice', tone: 'info', text: 'Kelpie restarted while you were working; your turn was cut off.' }] });
  });

  it('keeps the person’s words as theirs, whatever they look like', () => {
    const text = '<kelpie-notification> not really';
    expect(buildChat([{ ...base, id: 'u', seq: 0, kind: 'message', data: { role: 'user', text, sent: true, source: 'user' } }])).toEqual([{ role: 'user', id: 'u', text }]);
  });
});

describe('latestTodos', () => {
  it('is the round-up’s own latest list, not one a sub-agent of it kept', () => {
    const base = { runId: 'r', ts: '2026-01-01T00:00:00.000Z', harness: 'claude-code' as const, seq: 0, kind: 'todos' as const };
    const list = (id: string, text: string, parentCallId?: string) =>
      ({ ...base, id, ...(parentCallId ? { parentCallId } : {}), data: { items: [{ id: '1', text, status: 'pending' as const }] } }) as KelpieEvent;
    expect(latestTodos([list('a', 'old'), list('b', 'mine'), list('c', 'nested', 'call')]).map((t) => t.text)).toEqual(['mine']);
    expect(latestTodos([])).toEqual([]);
  });
});
