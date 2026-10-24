import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import { ClaudeCodeParser } from '@kelpie/adapters';
import { buildChat, type ToolView } from '../src/lib/chat.js';
import { modelLabel } from '../src/lib/harnesses.js';
import { roundUpSummary, type RoundUp } from '../src/lib/round-ups.js';
import { stepOf } from '../src/lib/steps.js';

const FIXTURES = join(import.meta.dirname, '../../../packages/adapters/fixtures/claude-code');

function tools(name: string): ToolView[] {
  const parser = new ClaudeCodeParser({ runId: 'r', now: () => '2026-01-01T10:32:00.000Z' });
  const events = readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l, i) => parser.parse(JSON.parse(l), i + 1)) as KelpieEvent[];
  return buildChat(events).flatMap((i) => (i.role === 'assistant' ? i.parts.filter((p): p is ToolView => p.type === 'tool') : []));
}

const tool = (over: Partial<ToolView>): ToolView => ({
  type: 'tool',
  callId: 'c',
  name: 'Bash',
  category: 'bash',
  title: '',
  input: {},
  state: 'done',
  steps: [],
  ts: '2026-01-01T10:32:00.000Z',
  ...over,
});

describe('stepOf', () => {
  it('says what each tool did in words, with the raw command kept for "Show commands"', () => {
    const steps = tools('edit-bash').map((t) => stepOf(t));
    expect(steps.map((s) => s.kind)).toEqual(['read', 'run', 'read', 'edit', 'edit', 'run']);
    expect(steps.find((s) => s.kind === 'edit')).toMatchObject({ title: 'Edited math.js', chips: [{ text: '+4 −0' }] });
    expect(steps.find((s) => s.kind === 'run')?.raw).toMatch(/^\$ /);
  });

  it('uses a command’s own description, and marks a failure with its first error line', () => {
    expect(stepOf(tool({ input: { command: 'pnpm test', description: 'Run the tests' } }))).toMatchObject({ title: 'Run the tests', raw: '$ pnpm test' });
    const failed = stepOf(tool({ input: { command: 'exit 3' }, state: 'error', output: 'Exit code 3\nmore' }));
    expect(failed).toMatchObject({ title: 'Ran a command', chips: [{ text: 'failed: Exit code 3', tone: 'fail' }] });
  });

  it('names agents in Kelpie’s own tools', () => {
    const read = tool({ name: 'mcp__kelpie__read_agent', category: 'mcp', input: { agentId: 'a1' } });
    expect(stepOf(read, (id) => (id === 'a1' ? 'Checkout API' : undefined)).title).toBe('Read the report from Checkout API');
    expect(stepOf(read).title).toBe('Read the report from an agent');
    expect(stepOf(tool({ name: 'mcp__kelpie__list_agents', category: 'mcp' })).title).toBe('Checked on the agents');
    expect(stepOf(tool({ name: 'mcp__github__get_issue', category: 'mcp' })).title).toBe('Used github/get_issue');
  });
});

describe('modelLabel', () => {
  it('says models the way people do', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-haiku-5')).toBe('Haiku 5');
    expect(modelLabel('sonnet')).toBe('Sonnet');
    expect(modelLabel('gpt-5-codex')).toBe('gpt-5-codex');
  });
});

describe('roundUpSummary', () => {
  const r = { id: 'r', title: 'x', cwd: '/', createdAt: 0, updatedAt: 0, busy: false } as RoundUp;
  const now = 5 * 60_000;
  it('says what the agents are up to, or that they are done', () => {
    expect(roundUpSummary(r, [{ status: 'working' }, { status: 'working' }, { status: 'failed' }, { status: 'done' }], now)).toBe('2 working · 1 failed');
    expect(roundUpSummary(r, [{ status: 'done' }, { status: 'done' }], now)).toBe('Done · 5 minutes ago');
    expect(roundUpSummary(r, [{ status: 'done' }, { status: 'idle' }], now)).toBe('Idle · 5 minutes ago');
  });

  it('falls back to the round-up’s own state without agents', () => {
    expect(roundUpSummary({ ...r, busy: true }, [], now)).toBe('Working');
    expect(roundUpSummary(r, [], now)).toBe('Idle · 5 minutes ago');
  });
});
