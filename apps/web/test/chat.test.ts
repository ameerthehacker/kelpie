import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import { ClaudeCodeParser } from '@kelpie/adapters';
import { buildChat, type AssistantPart, type ToolView } from '../src/lib/chat.js';

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

  it('shows the todo list once, at its latest state', () => {
    const todos = partsOf('todos').filter((p) => p.type === 'todos');
    expect(todos).toHaveLength(1);
    expect(todos[0]!.type === 'todos' && todos[0]!.items.map((t) => t.status)).toEqual(['completed', 'completed']);
    expect(toolsOf('todos').some((t) => t.category === 'todo')).toBe(false);
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
  it('shows a notification as a notice, not as the person speaking', () => {
    const base = { runId: 'r', ts: '2026-01-01T00:00:00.000Z', harness: 'claude-code' as const };
    const text = '<kelpie-notification>\n## Agent "Count A" (a1) is idle: turn completed\n\n4\n\n## Agent "Count B" (b1) is idle: turn failed\nError: x\n\nThis message is from Kelpie.\n</kelpie-notification>';
    const items = buildChat([{ ...base, id: 'n', seq: 0, kind: 'message', data: { role: 'user', text, sent: true, source: 'kelpie' } }]);
    expect(items).toEqual([{ role: 'assistant', id: 'n', parts: [{ type: 'notice', tone: 'info', text: 'Agent “Count A” finished\nAgent “Count B” stopped: turn failed' }] }]);
  });

  it('keeps the person’s words as theirs, whatever they look like', () => {
    const base = { runId: 'r', ts: '2026-01-01T00:00:00.000Z', harness: 'claude-code' as const };
    const text = '<kelpie-notification> not really';
    expect(buildChat([{ ...base, id: 'u', seq: 0, kind: 'message', data: { role: 'user', text, sent: true, source: 'user' } }])).toEqual([{ role: 'user', id: 'u', text }]);
  });
});
