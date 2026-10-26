import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import { ClaudeCodeParser } from '@kelpie/adapters';
import { agentsFromText, buildChat, latestTodos, reviewNotice, type AssistantPart, type ToolView } from '../src/lib/chat.js';

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
  it('shows questions put to the person as their card, open until answered, then with the answers', () => {
    const evs = events('ask');
    const resolved = evs.findIndex((e) => e.kind === 'permission.resolved');
    // The replayed fixture carries no answer of ours; add the one the spawner logs.
    const requested = evs.find((e) => e.kind === 'permission.requested');
    const requestId = requested?.kind === 'permission.requested' ? requested.data.requestId : '';
    const answer = { ...evs[0]!, id: 'x', kind: 'permission.resolved' as const, data: { requestId, decision: 'allow' as const, by: 'person' as const, answers: { 'Which color should the button be?': 'Blue' } } };
    const open = buildChat(evs.slice(0, evs.findIndex((e) => e.kind === 'permission.requested') + 1)).flatMap((i) => (i.role === 'assistant' ? i.parts : []));
    expect(open.filter((p) => p.type === 'tool')).toEqual([]);
    expect(open.filter((p) => p.type === 'question')).toMatchObject([{ state: 'open', requestId, questions: [{ question: 'Which color should the button be?', header: 'Color' }] }]);
    const parts = buildChat(resolved < 0 ? [...evs, answer] : [...evs.slice(0, resolved), answer, ...evs.slice(resolved)]).flatMap((i) => (i.role === 'assistant' ? i.parts : []));
    expect(parts.filter((p) => p.type === 'question')).toMatchObject([{ state: 'answered', answers: { 'Which color should the button be?': 'Blue' } }]);
  });

  it('marks skipped questions, and ones left open when the run ended', () => {
    const skipped = events('ask-skip');
    const at = skipped.findIndex((e) => e.kind === 'permission.requested');
    const req = skipped[at]!;
    const requestId = req.kind === 'permission.requested' ? req.data.requestId : '';
    const skip = { ...req, id: 'x', kind: 'permission.resolved' as const, data: { requestId, decision: 'deny' as const, by: 'person' as const } };
    const state = (evs: KelpieEvent[]) => buildChat(evs).flatMap((i) => (i.role === 'assistant' ? i.parts : [])).find((p) => p.type === 'question');
    expect(state([...skipped.slice(0, at + 1), skip])).toMatchObject({ state: 'skipped' });
    const exit = { ...req, id: 'y', kind: 'process.exited' as const, data: { code: 0, signal: null, stderrTail: '' } };
    expect(state([...skipped.slice(0, at + 1), exit])).toMatchObject({ state: 'expired' });
  });

  it('shows a turn’s files as attachments, without the block of paths the harness reads', () => {
    const base = { id: 'e1', runId: 'r', seq: 0, ts: '2026-01-01T00:00:00.000Z', harness: 'claude-code' as const };
    const text = 'Why is this red?\n\n<attachments>\n- /s/uploads/ab-shot.png (image/png, 2 KB)\n</attachments>';
    const attachments = [{ id: 'u1', name: 'shot.png', mime: 'image/png', size: 2048 }];
    const [item] = buildChat([{ ...base, kind: 'message', data: { role: 'user', text, sent: true, source: 'user', attachments } }]);
    expect(item).toMatchObject({ role: 'user', text: 'Why is this red?', attachments });
  });

  it('leaves out the note about untitled tickets Kelpie adds for the orchestrator, before any files', () => {
    const base = { id: 'e1', runId: 'r', seq: 0, ts: '2026-01-01T00:00:00.000Z', harness: 'claude-code' as const };
    const note = '<tickets>\nLinked to this round-up without a title: https://app.asana.com/0/1/2\nOnce you know a ticket’s name, set it with link_ticket.\n</tickets>';
    const [plain] = buildChat([{ ...base, kind: 'message', data: { role: 'user', text: `Fix https://app.asana.com/0/1/2\n\n${note}`, sent: true, source: 'user' } }]);
    expect(plain).toMatchObject({ text: 'Fix https://app.asana.com/0/1/2' });
    const attachments = [{ id: 'u1', name: 'shot.png', mime: 'image/png', size: 2048 }];
    const text = `Fix it\n\n${note}\n\n<attachments>\n- /s/uploads/ab-shot.png (image/png, 2 KB)\n</attachments>`;
    const [withFiles] = buildChat([{ ...base, kind: 'message', data: { role: 'user', text, sent: true, source: 'user', attachments } }]);
    expect(withFiles).toMatchObject({ text: 'Fix it', attachments });
  });

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
    expect(partsOf('interrupt').at(-1)).toMatchObject({ type: 'notice', tone: 'info', text: 'Interrupted.' });
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
    expect(items).toEqual([{ role: 'assistant', id: 'n', parts: [{ type: 'agents', agents, ts: '2026-01-01T00:00:00.000Z' }] }]);
  });

  it('takes reports from the text when the echo leaves them out', () => {
    const slim = agents.map(({ report: _, ...a }) => a);
    const items = buildChat([{ ...base, id: 'n', seq: 0, kind: 'message', data: { role: 'user', text, sent: true, source: 'kelpie', agents: slim } }]);
    expect(items).toEqual([{ role: 'assistant', id: 'n', parts: [{ type: 'agents', agents, ts: '2026-01-01T00:00:00.000Z' }] }]);
  });

  it('reads the agents out of notifications logged before echoes carried them', () => {
    const items = buildChat([{ ...base, id: 'n', seq: 0, kind: 'message', data: { role: 'user', text, sent: true } }]);
    expect(items).toEqual([{ role: 'assistant', id: 'n', parts: [{ type: 'agents', agents, ts: '2026-01-01T00:00:00.000Z' }] }]);
  });

  it('reads branch lines, and shows what Muster got into the feature branch as its own line', () => {
    const withBranch =
      '<kelpie-notification>\n## Agent "Muster: Copy" (m1) is idle: turn completed\nBranch: kelpie/x--copy-1 (0 commits ahead of the feature branch; to muster)\n\n## Outcome\ndone\n\n' +
      'In the feature branch now (checked with git): API, Docs. Still not mustered: Copy.\n\nThis message is from Kelpie, not the person. Use read_agent for more detail.\n</kelpie-notification>';
    const [item] = buildChat([{ ...base, id: 'n', seq: 0, kind: 'message', data: { role: 'user', text: withBranch, sent: true, source: 'kelpie' } }]);
    expect(item).toEqual({
      role: 'assistant',
      id: 'n',
      parts: [
        { type: 'agents', ts: base.ts, agents: [{ agentId: 'm1', title: 'Muster: Copy', status: 'completed', report: '## Outcome\ndone' }] },
        { type: 'notice', tone: 'info', ts: base.ts, text: 'Mustered into the feature branch: API, Docs · not yet: Copy' },
      ],
    });
  });

  it('shows a restart note as one line', () => {
    const note = '<kelpie-notification>\nKelpie restarted while you were working; your turn was cut off.\n</kelpie-notification>';
    const items = buildChat([{ ...base, id: 'n', seq: 0, kind: 'message', data: { role: 'user', text: note, sent: true, source: 'kelpie' } }]);
    expect(items[0]).toEqual({ role: 'assistant', id: 'n', parts: [{ type: 'notice', tone: 'info', text: 'Kelpie restarted while you were working; your turn was cut off.', ts: '2026-01-01T00:00:00.000Z' }] });
  });

  it('shows a submitted review as one line that leads to the Changes tab', () => {
    const text =
      '<kelpie-notification>\nThe person submitted a review of the feature\'s changes: Request changes.\n> Tighten these up\n## Agent "API" (a1): 2 threads\n- [t1] billing-api/package.json:6 (additions): "Use 22"\n' +
      'Act on it now (see your rules). This message is from Kelpie, not the person.\n</kelpie-notification>';
    const review = { reviewId: 'rv1', verdict: 'request_changes', comments: 3, threads: 2 };
    const data = { role: 'user', text, sent: true, source: 'kelpie', review } as unknown as Extract<KelpieEvent, { kind: 'message' }>['data'];
    const [item] = buildChat([{ ...base, id: 'n', seq: 0, kind: 'message', data }]);
    expect(item).toEqual({
      role: 'assistant',
      id: 'n',
      parts: [{ type: 'notice', tone: 'info', text: 'You submitted a review · Request changes · 3 comments', ts: base.ts, link: 'changes' }],
    });
    expect(reviewNotice({ verdict: 'approve', comments: 0 })).toBe('You submitted a review · Approve');
    expect(reviewNotice({ verdict: 'comment', comments: 1 })).toBe('You submitted a review · Comment · 1 comment');
    // Threads made on an agent's own Changes tab went straight to it.
    expect(reviewNotice({ verdict: 'comment', comments: 3, direct: [{ agentId: 'a1', title: 'gateway-web', threads: 2 }] })).toBe('You submitted a review · Comment · 3 comments · 2 sent to gateway-web');
    expect(reviewNotice({ verdict: 'request_changes', comments: 4, direct: [{ agentId: 'a1', title: 'API', threads: 2 }, { agentId: 'a2', title: 'Docs', threads: 1 }] })).toBe(
      'You submitted a review · Request changes · 4 comments · 2 sent to API, 1 to Docs',
    );
  });

  it('reads the review line of an idle notification as a detail, not the report', () => {
    const idle =
      '<kelpie-notification>\n## Agent "API" (a1) is idle: turn completed\nBranch: kelpie/x--api-1 (1 commit ahead of the feature branch; to muster)\nReview threads: 2 resolved, 1 open\n\nFixed both.\n\n' +
      'This message is from Kelpie, not the person.\n</kelpie-notification>';
    expect(agentsFromText(idle)).toEqual([{ agentId: 'a1', title: 'API', status: 'completed', report: 'Fixed both.' }]);
  });

  it('keeps the person’s words as theirs, whatever they look like', () => {
    const text = '<kelpie-notification> not really';
    expect(buildChat([{ ...base, id: 'u', seq: 0, kind: 'message', data: { role: 'user', text, sent: true, source: 'user' } }])).toEqual([{ role: 'user', id: 'u', text, ts: '2026-01-01T00:00:00.000Z', source: 'user' }]);
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
