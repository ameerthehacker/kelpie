import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KelpieEvent, type EventOf } from '@kelpie/protocol';
import { ClaudeCodeParser, LineSplitter } from '../src/index.js';
import { applyTodoTool, toolTitle } from '../src/claude-code/tools.js';

const DIR = join(import.meta.dirname, '../fixtures/claude-code');
const FIXTURES = readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, ''));

const lines = (name: string) => readFileSync(join(DIR, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const newParser = () => new ClaudeCodeParser({ runId: 'run', now: () => '2026-01-01T00:00:00.000Z' });

function replay(name: string): KelpieEvent[] {
  const parser = newParser();
  return lines(name).flatMap((o, i) => parser.parse(o, i + 1));
}

const of = <K extends KelpieEvent['kind']>(evs: KelpieEvent[], kind: K) =>
  evs.filter((e): e is EventOf<K> => e.kind === kind);

describe.each(FIXTURES)('fixture %s', (name) => {
  const events = replay(name);

  it('matches the golden snapshot', () => {
    expect(events).toMatchSnapshot();
  });

  it('emits only schema-valid events with a contiguous seq', () => {
    events.forEach((e, i) => {
      expect(KelpieEvent.safeParse(e).error).toBeUndefined();
      expect(e.seq).toBe(i);
    });
  });

  it('closes every tool call and ends every turn', () => {
    const started = of(events, 'tool.started').map((e) => e.data.callId);
    const finished = of(events, 'tool.finished').map((e) => e.data.callId);
    expect(new Set(finished)).toEqual(new Set(started));
    expect(of(events, 'turn.ended').length).toBeGreaterThan(0);
    expect(of(events, 'session.started')).toHaveLength(1);
  });
});

describe('claude-code mapping', () => {
  it('categorizes tools and titles them relative to the repo', () => {
    const titles = of(replay('read-search'), 'tool.started').map((e) => [e.data.category, e.data.title]);
    expect(titles[1]).toEqual(['read', 'src/math.js']);
    expect(titles[0]![0]).toBe('search');
  });

  it('counts changed lines from the CLI patch, and whole-file writes', () => {
    const changes = of(replay('edit-bash'), 'file.changed').map(({ data: { path, op, added, removed } }) => ({ path, op, added, removed }));
    expect(changes).toEqual([
      { path: '/work/repo/src/math.js', op: 'edit', added: 4, removed: 0 },
      { path: '/work/repo/test/sub.test.js', op: 'write', added: 5, removed: 0 },
    ]);
  });

  it('tracks TaskCreate/TaskUpdate as a todo list', () => {
    const snaps = of(replay('todos'), 'todos').map((e) => e.data.items.map((t) => `${t.id}:${t.text}:${t.status}`));
    expect(snaps[0]).toEqual(['1:Count lines:pending']);
    expect(snaps.at(-1)).toEqual(['1:Count lines:completed', '2:Report:completed']);
  });

  it('reports a failing command as a failed tool, not a failed turn', () => {
    const evs = replay('bash-fail');
    expect(of(evs, 'tool.finished')[0]!.data).toMatchObject({ ok: false, output: 'Exit code 3' });
    expect(of(evs, 'turn.ended')[0]!.data.status).toBe('completed');
  });

  it('attributes sub-agent events to the spawning call', () => {
    const evs = replay('subagent');
    const agent = of(evs, 'tool.started').find((e) => e.data.category === 'task')!;
    const inner = evs.filter((e) => e.parentCallId === agent.data.callId);
    expect(inner.map((e) => e.kind)).toEqual(expect.arrayContaining(['message', 'tool.started', 'tool.finished']));
    expect(of(inner, 'tool.started')[0]!.data.name).toBe('Read');
  });

  it('keeps one session across turns and reports each turn', () => {
    const evs = replay('multi-turn');
    expect(of(evs, 'turn.ended').map((e) => e.data.resultText)).toEqual(['OK', 'kelpie']);
    expect(of(evs, 'message').filter((e) => e.data.role === 'user')).toHaveLength(2);
  });

  it('reports cost per turn although the CLI reports it cumulatively', () => {
    const cumulative = lines('multi-turn').filter((o) => o.type === 'result').map((o) => o.total_cost_usd as number);
    const perTurn = of(replay('multi-turn'), 'usage').map((e) => e.data.costUsd!);
    expect(perTurn[0]).toBeCloseTo(cumulative[0]!, 10);
    expect(perTurn[0]! + perTurn[1]!).toBeCloseTo(cumulative[1]!, 10);
  });

  it('does not double-charge after an aborted turn reports zero cost', () => {
    const parser = newParser();
    const cost = (total: number) =>
      parser.parse({ type: 'result', subtype: 'success', total_cost_usd: total, usage: {} }).find((e) => e.kind === 'usage')!.data;
    expect([cost(0.003), cost(0), cost(0.006)].map((d) => (d as { costUsd: number }).costUsd)).toEqual([0.003, 0, 0.003]);
  });

  it('tracks busy across queued turns the CLI merges into one result', () => {
    const parser = newParser();
    for (let i = 0; i < 3; i++) parser.noteSent();
    const busyAtEnds: boolean[] = [];
    lines('queued').forEach((o, i) => {
      for (const e of parser.parse(o, i + 1)) if (e.kind === 'turn.ended') busyAtEnds.push(parser.busy);
    });
    expect(busyAtEnds).toEqual([false]);
    expect(of(replay('queued'), 'message').filter((e) => e.data.role === 'user')).toHaveLength(3);
  });

  it('treats a turn the CLI starts itself (background agent finished) as busy', () => {
    const parser = newParser();
    parser.noteSent();
    const states: string[] = [];
    lines('background-agent').forEach((o, i) => {
      for (const e of parser.parse(o, i + 1)) {
        if (e.kind === 'turn.ended') states.push(`ended:${parser.busy}`);
        if (e.kind === 'tool.started' && e.parentCallId) states.push(`sub:${parser.busy}`);
      }
    });
    expect(states).toEqual(['ended:false', 'sub:true', 'ended:false']);
  });

  it('reads an aborted turn as interrupted', () => {
    expect(of(replay('interrupt'), 'turn.ended')[0]!.data.status).toBe('interrupted');
  });

  it('swallows both interrupt markers instead of reporting them as user messages', () => {
    const parser = new ClaudeCodeParser({ runId: 'r' });
    for (const text of ['[Request interrupted by user]', '[Request interrupted by user for tool use]']) {
      expect(parser.parse({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })).toEqual([]);
    }
  });

  it('maps usage, cost and rate limits', () => {
    const evs = replay('plain');
    expect(of(evs, 'usage')[0]!.data.costUsd).toBeGreaterThan(0);
    expect(of(evs, 'rate_limit')[0]!.data).toMatchObject({ status: 'allowed', window: 'five_hour' });
  });

  it('omits the search location when it is the repo root', () => {
    expect(toolTitle('Grep', { pattern: 'add', path: '/work/repo' }, '/work/repo')).toBe('add');
    expect(toolTitle('Grep', { pattern: 'add', path: '/work/repo/src' }, '/work/repo')).toBe('add in src');
  });

  it('ignores updates to todos it never saw created', () => {
    const items = [{ id: '1', text: 'a', status: 'pending' as const }];
    expect(applyTodoTool('TaskUpdate', { taskId: '9', status: 'completed' }, { success: true }, items)).toBeUndefined();
  });

  it('keeps unknown events as `other`', () => {
    const parser = new ClaudeCodeParser({ runId: 'r' });
    expect(parser.parse({ type: 'brand_new_thing', x: 1 })[0]).toMatchObject({ kind: 'other', data: { type: 'brand_new_thing' } });
  });
});

describe('LineSplitter', () => {
  it('reassembles lines split across chunks', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":')).toEqual([]);
    expect(s.push('1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\r\n\n')).toEqual(['{"b":2}']);
    expect(s.push('{"c":3}')).toEqual([]);
    expect(s.flush()).toEqual(['{"c":3}']);
  });
});
