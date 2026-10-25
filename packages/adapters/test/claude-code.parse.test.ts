import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KelpieEvent, type EventOf } from '@kelpie/protocol';
import { ClaudeCodeParser } from '../src/index.js';
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
      const evs = parser.parse({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
      expect(evs.filter((e) => e.kind === 'message')).toEqual([]);
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

  it('titles Claude in Chrome calls by what they do in the browser', () => {
    const chrome = (tool: string, input: Record<string, unknown>) => toolTitle(`mcp__claude-in-chrome__${tool}`, { tabId: 7, ...input }, '/work/repo');
    expect(chrome('navigate', { url: 'https://claude.ai/public/artifacts/x' })).toBe('Chrome: navigate https://claude.ai/public/artifacts/x');
    expect(chrome('computer', { action: 'left_click', coordinate: [120, 340] })).toBe('Chrome: left_click (120, 340)');
    expect(chrome('computer', { action: 'left_click', ref: 'ref_12' })).toBe('Chrome: left_click ref_12');
    expect(chrome('computer', { action: 'type', text: 'hello' })).toBe('Chrome: type "hello"');
    expect(chrome('computer', { action: 'scroll', scroll_direction: 'down', coordinate: [1, 2] })).toBe('Chrome: scroll down (1, 2)');
    expect(chrome('computer', { action: 'screenshot' })).toBe('Chrome: screenshot');
    expect(chrome('form_input', { ref: 'ref_3', value: 'me@example.com' })).toBe('Chrome: fill ref_3 with "me@example.com"');
    expect(chrome('find', { query: 'the publish button' })).toBe('Chrome: find "the publish button"');
    expect(chrome('javascript_tool', { action: 'javascript_exec', text: 'document.title\n// more' })).toBe('Chrome: run JavaScript document.title // more');
    expect(chrome('tabs_create_mcp', {})).toBe('Chrome: tabs_create_mcp');
  });

  it('ignores updates to todos it never saw created', () => {
    const items = [{ id: '1', text: 'a', status: 'pending' as const }];
    expect(applyTodoTool('TaskUpdate', { taskId: '9', status: 'completed' }, { success: true }, items)).toBeUndefined();
  });

  it('emits activity on every busy flip, in order with the turn', () => {
    const kinds = replay('multi-turn').filter((e) => ['activity', 'turn.ended'].includes(e.kind));
    expect(kinds.map((e) => (e.kind === 'activity' ? `busy:${e.data.busy}` : e.kind))).toEqual([
      'busy:true', 'turn.ended', 'busy:false', 'busy:true', 'turn.ended', 'busy:false',
    ]);
  });

  it('turns the CLI asking before a command into a permission request, with the rule that would allow it', () => {
    const [req] = of(replay('permission'), 'permission.requested');
    expect(req?.data).toMatchObject({ tool: 'Bash', title: 'node -e "console.log(41+1)"', rule: 'Bash(node -e "console.log(41+1)")' });
    // The echo of our own answer is not news.
    expect(of(replay('permission'), 'other').some((e) => JSON.stringify(e.data).includes('control_response'))).toBe(false);
  });

  it('puts a plan to the person as a permission request carrying the plan', () => {
    const [req] = of(replay('plan'), 'permission.requested');
    expect(req?.data.tool).toBe('ExitPlanMode');
    expect(req?.data.title).toBe('Approve the plan');
    expect(req?.data.plan).toMatch(/sub/);
  });

  it('gives a compound command no rule, so allowing one part can never let the rest through', () => {
    const parser = newParser();
    const [req] = of(
      parser.parse({
        type: 'control_request',
        request_id: 'x',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'pnpm install && rm -rf ~/x' },
          permission_suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'pnpm install' }, { toolName: 'Bash', ruleContent: 'rm -rf ~/x' }] }],
        },
      }),
      'permission.requested',
    );
    expect(req?.data.rule).toBeUndefined();
  });

  it('gives the Claude in Chrome tools no rule, so no browser action can be allowed for the next one', () => {
    const parser = newParser();
    const [req] = of(
      parser.parse({
        type: 'control_request',
        request_id: 'x',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'mcp__claude-in-chrome__computer',
          input: { action: 'left_click', ref: 'ref_12', tabId: 1 },
          permission_suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'mcp__claude-in-chrome__computer' }] }],
        },
      }),
      'permission.requested',
    );
    expect(req?.data).toMatchObject({ tool: 'mcp__claude-in-chrome__computer', title: 'Chrome: left_click ref_12' });
    expect(req?.data.rule).toBeUndefined();
  });

  it("falls back on the turn's own last message for a plan, never an earlier turn's", () => {
    const parser = newParser();
    const plan = () => of(parser.parse({ type: 'control_request', request_id: String(Math.random()), request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: {} } }), 'permission.requested')[0]?.data.plan;
    parser.parse({ type: 'assistant', message: { content: [{ type: 'text', text: '1. Add sub' }] } });
    expect(plan()).toBe('1. Add sub');
    parser.parse({ type: 'result', subtype: 'success', usage: {} });
    expect(plan()).toBeUndefined();
  });

  it('closes a permission request once: answered, cancelled by the CLI, or left open when the process ends', () => {
    const parser = newParser();
    const ask = (id: string) => parser.parse({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
    ask('a');
    ask('b');
    ask('c');
    expect(parser.permissionInput('a')).toEqual({ command: 'ls' });
    expect(parser.noteAnswered('a', { decision: 'allow', by: 'person' }).map((e) => e.data)).toEqual([{ requestId: 'a', decision: 'allow', by: 'person' }]);
    expect(parser.noteAnswered('a', { decision: 'deny', by: 'person' })).toEqual([]);
    expect(of(parser.parse({ type: 'control_cancel_request', request_id: 'b' }), 'permission.resolved').map((e) => e.data.by)).toEqual(['cancelled']);
    expect(of(parser.noteExited(), 'permission.resolved').map((e) => [e.data.requestId, e.data.by])).toEqual([['c', 'expired']]);
    expect(parser.permissionInput('c')).toBeUndefined();
  });

  it('keeps unknown events as `other`', () => {
    const parser = new ClaudeCodeParser({ runId: 'r' });
    expect(parser.parse({ type: 'brand_new_thing', x: 1 })[0]).toMatchObject({ kind: 'other', data: { type: 'brand_new_thing' } });
  });
});
