import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeParser } from '@kelpie/adapters';
import type { KelpieEvent } from '@kelpie/protocol';
import { logLines, report } from '../src/index.js';

const DIR = join(import.meta.dirname, '../../adapters/fixtures/claude-code');

function replay(name: string): KelpieEvent[] {
  const parser = new ClaudeCodeParser({ runId: 'run', now: () => '2026-01-01T00:00:00.000Z' });
  return readFileSync(join(DIR, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l, i) => parser.parse(JSON.parse(l), i + 1));
}

describe('agent digests', () => {
  it.each(['plain', 'edit-bash', 'bash-fail', 'todos', 'multi-turn', 'subagent'])('%s report and log match the golden snapshot', (name) => {
    const events = replay(name);
    expect(report(events)).toMatchSnapshot('report');
    expect(logLines(events).lines).toMatchSnapshot('log');
  });

  it('reports the final answer of the last turn and totals per file', () => {
    const r = report(replay('edit-bash'));
    expect(r.lastTurn).toBe('completed');
    expect(r.report).not.toBe('');
    expect(r.filesChanged.length).toBeGreaterThan(0);
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it('reports only what the last turn said', () => {
    const base = { runId: 'r', ts: '2026-01-01T00:00:00.000Z', harness: 'claude-code' as const };
    const events = [
      { ...base, id: '0', seq: 0, kind: 'message', data: { role: 'assistant', text: 'R1' } },
      { ...base, id: '1', seq: 1, kind: 'turn.ended', data: { status: 'completed' } },
      { ...base, id: '2', seq: 2, kind: 'message', data: { role: 'user', text: 'follow-up', sent: true } },
      { ...base, id: '3', seq: 3, kind: 'turn.ended', data: { status: 'failed', error: 'boom' } },
    ] as KelpieEvent[];
    expect(report(events)).toMatchObject({ report: '', lastTurn: 'failed', error: 'boom', turns: 2 });
  });

  it('pages through the log with a cursor, never repeating or skipping a line', () => {
    const events = replay('multi-turn');
    const all = logLines(events).lines;
    const paged: string[] = [];
    let after = -1;
    for (;;) {
      const page = logLines(events, after, 2);
      paged.push(...page.lines);
      after = page.nextCursor;
      if (!page.more) break;
    }
    expect(paged).toEqual(all);
  });
});
