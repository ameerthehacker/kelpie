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

  it('takes a local command the CLI never replays (/context) as sent, so the turn ends idle', () => {
    const parser = newParser();
    for (let i = 0; i < 3; i++) parser.noteSent();
    const seen: string[] = [];
    lines('local-commands').forEach((o, i) => {
      for (const e of parser.parse(o, i + 1)) {
        if (e.kind === 'message') seen.push(`${e.data.role}${e.data.sent ? ' sent' : ''}: ${e.data.text.split('\n')[0]}`);
        if (e.kind === 'turn.ended') seen.push(`ended, busy ${parser.busy}`);
      }
    });
    expect(seen).toEqual([
      // Before its output, as a replay would be.
      'user sent: /context',
      'assistant: ## Context Usage',
      'ended, busy true',
      'user sent: <command-message>proj-hello</command-message>',
      expect.stringMatching(/^assistant: /),
      'ended, busy true',
      'user: This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
      // /compact is replayed (as its output): it is not taken in twice.
      'user sent: <local-command-stdout>Compacted </local-command-stdout>',
      'ended, busy false',
    ]);
  });

  it('takes a local command in at its result when it printed nothing, and never more than was sent', () => {
    const parser = newParser();
    parser.noteSent();
    const evs = parser.parse({ type: 'result', subtype: 'success', local_command: 'reload-skills', usage: {} });
    expect(of(evs, 'message').map((e) => e.data)).toEqual([{ role: 'user', text: '/reload-skills', sent: true }]);
    expect(parser.busy).toBe(false);
    expect(of(parser.parse({ type: 'result', subtype: 'success', local_command: 'usage', usage: {} }), 'message')).toEqual([]);
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

  it('applies updates to todos a resumed session created before', () => {
    const created = new Set(lines('todos').flatMap((o) => (o.message?.content ?? []).filter((b: any) => b.name === 'TaskCreate').map((b: any) => b.id)));
    const resumed = lines('todos').filter((o) => !(o.message?.content ?? []).some((b: any) => created.has(b.id) || created.has(b.tool_use_id)));
    const todos = [
      { id: '1', text: 'Count lines', status: 'pending' as const },
      { id: '2', text: 'Report', status: 'pending' as const },
    ];
    const seed = structuredClone(todos);
    const parser = new ClaudeCodeParser({ runId: 'r', todos });
    const evs = resumed.flatMap((o, i) => parser.parse(o, i + 1));
    expect(of(evs, 'todos').at(-1)!.data.items.map((t) => `${t.id}:${t.status}`)).toEqual(['1:completed', '2:completed']);
    expect(todos).toEqual(seed); // the caller's list is left as it was
  });

  it('replaces a todo whose id is created again, rather than listing it twice', () => {
    const items = [
      { id: '1', text: 'old', status: 'completed' as const },
      { id: '2', text: 'other', status: 'pending' as const },
    ];
    expect(applyTodoTool('TaskCreate', { subject: 'new' }, { task: { id: '1' } }, items)).toEqual([
      { id: '1', text: 'new', status: 'pending' },
      { id: '2', text: 'other', status: 'pending' },
    ]);
    expect(items[0]!.text).toBe('old');
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

  it('puts structured questions to the person as a permission request carrying them, and reads back the answers', () => {
    const events = replay('ask');
    const [req] = of(events, 'permission.requested');
    expect(req?.data).toMatchObject({
      tool: 'AskUserQuestion',
      title: 'Which color should the button be?',
      questions: [{ question: 'Which color should the button be?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] }],
    });
    expect(req?.data.rule).toBeUndefined();
    // Allowing it with the answers (in updatedInput) is how they reach the model.
    const [done] = of(events, 'tool.finished');
    expect(done?.data).toMatchObject({ name: 'AskUserQuestion', ok: true, output: expect.stringContaining('"Which color should the button be?"="Blue"') });
    // Skipped (a deny), the tool fails and the model carries on without an answer.
    expect(of(replay('ask-skip'), 'tool.finished')[0]?.data.ok).toBe(false);
    // Auto mode, as agents run, still asks us rather than settling it itself.
    expect(of(replay('ask-auto'), 'permission.requested')[0]?.data.tool).toBe('AskUserQuestion');
  });

  it('keeps only well-formed questions, and titles several by their count', () => {
    const parser = newParser();
    const [req] = of(
      parser.parse({
        type: 'control_request',
        request_id: 'q',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: { questions: [{ question: 'A?', header: '', options: [{ label: 'x', description: '' }, { nope: 1 }], multiSelect: true }, { question: 'B?', options: [] }, 'junk'] },
        },
      }),
      'permission.requested',
    );
    expect(req?.data.title).toBe('Answer 2 questions');
    expect(req?.data.questions).toEqual([{ question: 'A?', options: [{ label: 'x' }], multiSelect: true }, { question: 'B?', options: [] }]);
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

  it("asks about a person's MCP tool by server, tool and arguments, with a rule for that one tool", () => {
    // As the CLI asks under an ask rule, in auto mode (mcp-ask.jsonl): no suggested rule of its own.
    const [req] = of(replay('mcp-ask'), 'permission.requested');
    expect(req?.data).toMatchObject({ tool: 'mcp__claude_ai_Claude_Docs__guide', title: 'claude.ai Claude Docs › guide', rule: 'mcp__claude_ai_Claude_Docs__guide' });
    const parser = newParser();
    const [withArgs] = of(
      parser.parse({
        type: 'control_request',
        request_id: 'y',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'mcp__github__search_issues',
          mcp_server: { name: 'github', source: 'dynamic' },
          input: { query: 'is:open label:bug', limit: 5, filters: { repo: 'a/b', text: 'x'.repeat(80) } },
          // A suggestion for the whole server is not taken: only the one tool is ever remembered.
          permission_suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'mcp__github' }] }],
        },
      }),
      'permission.requested',
    );
    expect(withArgs?.data.rule).toBe('mcp__github__search_issues');
    expect(withArgs?.data.title).toMatch(/^github › search_issues · query: "is:open label:bug", limit: 5, filters: \{"repo":"a\/b","text":"x{10,}…$/);
    expect(withArgs!.data.title.length).toBeLessThanOrEqual(160);
  });

  it("writes out hidden characters in an MCP call's title: a bidi override can't make it read as another", () => {
    const [req] = of(
      newParser().parse({
        type: 'control_request',
        request_id: 'z',
        request: { subtype: 'can_use_tool', tool_name: 'mcp__gh__run', mcp_server: { name: 'gh\u200b', source: 'dynamic' }, input: { path: 'a\u202etxt.exe' } },
      }),
      'permission.requested',
    );
    expect(req?.data.title).toBe('gh\\u{200b} › run · path: "a\\u{202e}txt.exe"');
  });

  it('asks about a claude.ai-style server with spaces and dashes in auto mode, by the tool name the CLI gives it', () => {
    // Captured from Claude Code 2.1.308 in auto mode with the ask rule mcp__claude_ai_My_Tiny_-_Echo
    // (mcp-ask-dashes.jsonl): the call arrived as can_use_tool, settled by that rule (flagSettings).
    const [req] = of(replay('mcp-ask-dashes'), 'permission.requested');
    expect(req?.data).toMatchObject({ tool: 'mcp__claude_ai_My_Tiny_-_Echo__echo', title: 'claude.ai My  Tiny - Echo › echo · text: "hi"', rule: 'mcp__claude_ai_My_Tiny_-_Echo__echo' });
    const init = lines('mcp-ask-dashes')[0];
    expect(init.permissionMode).toBe('auto');
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

  it('closes a question the person was asked when the turn is interrupted', () => {
    // The real CLI cancels it itself.
    const events = replay('ask-interrupt');
    const [req] = of(events, 'permission.requested');
    expect(of(events, 'permission.resolved').map((e) => [e.data.requestId, e.data.by])).toEqual([[req!.data.requestId, 'cancelled']]);
    expect(of(events, 'turn.ended')[0]?.data.status).toBe('interrupted');

    // Were it not to, the turn's end closes it; a sub-agent's request outlives the turn.
    const parser = newParser();
    parser.parse({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'mine', name: 'AskUserQuestion', input: {} }] } });
    parser.parse({ type: 'assistant', parent_tool_use_id: 'agent', message: { content: [{ type: 'tool_use', id: 'theirs', name: 'Bash', input: { command: 'ls' } }] } });
    const ask = (id: string, callId: string, tool: string) => parser.parse({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, tool_use_id: callId, input: {} } });
    ask('q', 'mine', 'AskUserQuestion');
    ask('b', 'theirs', 'Bash');
    // A turn that simply ends leaves them be.
    expect(of(parser.parse({ type: 'result', subtype: 'success', usage: {} }), 'permission.resolved')).toEqual([]);
    const ended = parser.parse({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', usage: {} });
    expect(of(ended, 'permission.resolved').map((e) => [e.data.requestId, e.data.by])).toEqual([['q', 'expired']]);
    expect(parser.permissionInput('q')).toBeUndefined();
    expect(parser.permissionInput('b')).toEqual({});
  });

  it('carries text and number questions, with their range, and option previews', () => {
    const parser = newParser();
    const [req] = of(
      parser.parse({
        type: 'control_request',
        request_id: 'k',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: {
            questions: [
              { question: 'Name?', kind: 'text', placeholder: 'kelp', description: 'One word', options: [{ label: 'stray' }], multiSelect: true },
              { question: 'Slides?', kind: 'number', min: 3, max: 20, step: 1, defaultValue: 8, unit: 'slides', placeholder: 'no' },
              { question: 'Layout?', kind: 'choice', options: [{ label: 'Grid', preview: '[][]' }, { label: 'List' }], min: 1 },
            ],
          },
        },
      }),
      'permission.requested',
    );
    expect(req?.data.questions).toEqual([
      { question: 'Name?', kind: 'text', placeholder: 'kelp', description: 'One word', options: [] },
      { question: 'Slides?', kind: 'number', min: 3, max: 20, step: 1, defaultValue: 8, unit: 'slides', options: [] },
      { question: 'Layout?', options: [{ label: 'Grid', preview: '[][]' }, { label: 'List' }] },
    ]);
    // Asked for them in Kelpie's mode (stdio permission prompts), the CLI offers no kinds: the model asks a choice.
    expect(of(replay('ask-kinds'), 'permission.requested')[0]?.data.questions?.every((q) => !q.kind && q.options.length >= 2)).toBe(true);
  });

  it('keeps unknown events as `other`', () => {
    const parser = new ClaudeCodeParser({ runId: 'r' });
    expect(parser.parse({ type: 'brand_new_thing', x: 1 })[0]).toMatchObject({ kind: 'other', data: { type: 'brand_new_thing' } });
  });
});
