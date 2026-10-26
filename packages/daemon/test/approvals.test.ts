import { chmodSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore } from '@kelpie/store';
import { createApp, DENIED, Orchestrator, SessionManager, SKIPPED } from '../src/index.js';

const FAKE = join(import.meta.dirname, '../../adapters/test/fake-claude.mjs');
const FIXTURE = join(import.meta.dirname, '../../adapters/fixtures/claude-code/plain.jsonl');
chmodSync(FAKE, 0o755);

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const jsonLines = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}

const managers: SessionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stopAll()));
});

/** A round-up whose agents (and orchestrator) each ask to run `pnpm install` before their first turn. */
function setup(store = openStore(':memory:'), env: Record<string, string> = {}) {
  const answers = join(tmp('kelpie-answers-'), 'answers.jsonl');
  const argsFile = join(tmp('kelpie-args-'), 'args.jsonl');
  const orch = new Orchestrator({ store, mcpUrl: 'http://127.0.0.1:7317/mcp', notifyDelayMs: 60_000 });
  const sessions = new SessionManager({
    store,
    defaultCwd: tmpdir(),
    runsDir: tmp('kelpie-runs-'),
    defaults: { bin: FAKE, env: { FAKE_FIXTURE: FIXTURE, FAKE_ASK: 'pnpm install', FAKE_ANSWER_FILE: answers, FAKE_ARGS_FILE: argsFile, ...env } },
    hooks: orch,
  });
  orch.attach(sessions);
  managers.push(sessions);
  return { store, orch, sessions, answers, argsFile, app: createApp(sessions, { orchestrator: orch }) };
}

/** An orchestrator round-up with `n` read-only agents, all asking. */
async function roundUp(ctx: ReturnType<typeof setup>, n: number) {
  const parent = ctx.sessions.create();
  await parent.send('Go');
  // The orchestrator's own Bash request is refused by Kelpie's policy, never shown to the person.
  await waitFor(() => jsonLines<{ behavior: string }>(ctx.answers).length === 1);
  const agents = [];
  for (let i = 0; i < n; i++) {
    const a = await ctx.orch.spawn(parent, { title: `Agent ${i + 1}`, task: 'install and test', writes: false });
    agents.push(ctx.sessions.get(a.agentId)!);
  }
  await waitFor(() => ctx.sessions.approvals(parent.id).length === n);
  return { parent, agents };
}

describe('approvals', () => {
  it('turns down what the orchestrator itself asks for, without asking the person', async () => {
    const ctx = setup();
    const parent = ctx.sessions.create();
    await parent.send('Go');
    const [answer] = await waitFor(() => jsonLines<{ behavior: string; message: string }>(ctx.answers).length === 1 && jsonLines<{ behavior: string; message: string }>(ctx.answers));
    expect(answer).toMatchObject({ behavior: 'deny' });
    expect(answer!.message).toMatch(/only use your kelpie tools/);
    expect(ctx.sessions.approvals()).toEqual([]);
    const resolved = await waitFor(() => parent.events().find((e) => e.kind === 'permission.resolved'));
    expect(resolved.kind === 'permission.resolved' && resolved.data.by).toBe('kelpie');
  });

  it('queues what agents ask for, grouped by rule, until the person answers', async () => {
    const ctx = setup();
    const { parent, agents } = await roundUp(ctx, 2);
    // The agents ask at once, so in either order.
    const pending = ctx.sessions.approvals(parent.id).sort((x, y) => x.agentTitle.localeCompare(y.agentTitle));
    expect(pending.map((p) => [p.agentTitle, p.tool, p.title, p.rule])).toEqual([
      ['Agent 1', 'Bash', 'pnpm install', 'Bash(pnpm install)'],
      ['Agent 2', 'Bash', 'pnpm install', 'Bash(pnpm install)'],
    ]);
    expect(agents[0]!.summary().status).toBe('needs-approval');
    expect((await ctx.orch.list(parent)).agents.map((a) => a.status)).toEqual(['needs approval', 'needs approval']);

    const res = await ctx.app.request('/api/approvals?roundUp=' + parent.id, { headers: { host: '127.0.0.1:7317' } });
    expect(((await res.json()) as { approvals: unknown[]; rules: unknown[] })).toMatchObject({ approvals: [{ rule: 'Bash(pnpm install)' }, { rule: 'Bash(pnpm install)' }], rules: [] });
  });

  it('allows for the whole round-up: saves the rule, answers the others asking it, and starts later agents with it', async () => {
    const ctx = setup();
    const { parent, agents } = await roundUp(ctx, 2);
    const pushed: number[] = [];
    ctx.sessions.watch((u) => u.type === 'approvals' && pushed.push(u.approvals.length));
    const first = ctx.sessions.approvals(parent.id).find((p) => p.agentTitle === 'Agent 1');
    const results = await ctx.sessions.answerApprovals({ items: [{ sessionId: first!.sessionId, requestId: first!.requestId }], allow: true, remember: true });
    expect(results).toEqual([{ sessionId: first!.sessionId, requestId: first!.requestId, ok: true }]);
    await waitFor(() => ctx.sessions.approvals(parent.id).length === 0);
    expect(pushed.at(-1)).toBe(0);

    // The person's answer carries the rule for that process; the other agent was answered by Kelpie.
    const answers = await waitFor(() => jsonLines<{ behavior: string; updatedPermissions?: unknown[] }>(ctx.answers).length === 3 && jsonLines<{ behavior: string; updatedPermissions?: unknown[] }>(ctx.answers).slice(1));
    expect(answers.map((a) => a.behavior)).toEqual(['allow', 'allow']);
    expect(answers[0]!.updatedPermissions).toEqual([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm install' }], behavior: 'allow', destination: 'session' }]);
    const by = (s: (typeof agents)[number]) => s.events().flatMap((e) => (e.kind === 'permission.resolved' ? [e.data.by] : []));
    expect(by(agents[0]!)).toEqual(['person']);
    expect(by(agents[1]!)).toEqual(['kelpie']);
    expect(ctx.sessions.rules(parent.id).map((r) => r.rule)).toEqual(['Bash(pnpm install)']);

    // A later agent starts with the rule, and if it asks anyway it is answered without the person.
    const later = await ctx.orch.spawn(parent, { title: 'Agent 3', task: 'more', writes: false });
    const argv = await waitFor(() => jsonLines<string[]>(ctx.argsFile).at(-1)?.includes('Bash(pnpm install)') && jsonLines<string[]>(ctx.argsFile).at(-1));
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBeDefined();
    await waitFor(() => ctx.sessions.get(later.agentId)!.events().some((e) => e.kind === 'permission.resolved'));
    expect(ctx.sessions.approvals(parent.id)).toEqual([]);

    // Forgotten again: it no longer starts agents.
    const [rule] = ctx.sessions.rules(parent.id);
    expect(ctx.sessions.deleteRule(parent.id, rule!.id)).toBe(true);
    expect(ctx.sessions.rules(parent.id)).toEqual([]);
  });

  it('never saves or applies a rule for the Claude in Chrome tools, even one saved before', async () => {
    const ctx = setup(openStore(':memory:'), { FAKE_ASK: 'https://claude.ai/', FAKE_ASK_TOOL: 'mcp__claude-in-chrome__navigate' });
    const parent = ctx.sessions.create();
    await parent.send('Go');
    await waitFor(() => jsonLines(ctx.answers).length === 1);
    // As if saved by an earlier Kelpie, which offered "Allow for round-up" for them.
    ctx.store.addRule(parent.id, 'mcp__claude-in-chrome__navigate');
    ctx.store.addRule(parent.id, 'Bash(pnpm install)');
    const { agentId } = await ctx.orch.spawn(parent, { title: 'Browse', task: 'open the artifact', writes: false, browser: true });
    const [pending] = await waitFor(() => ctx.sessions.approvals(parent.id).length === 1 && ctx.sessions.approvals(parent.id));
    expect(pending).toMatchObject({ sessionId: agentId, tool: 'mcp__claude-in-chrome__navigate', title: 'Chrome: navigate https://claude.ai/' });
    expect(pending!.rule).toBeUndefined();
    const argv = jsonLines<string[]>(ctx.argsFile).at(-1)!;
    const allowed = argv.slice(argv.indexOf('--allowedTools') + 1, argv.findIndex((a, i) => i > argv.indexOf('--allowedTools') && a.startsWith('--')));
    expect(allowed).toEqual(['Bash(pnpm install)']);

    // "Remember" can't save one either: the person allowed this request only.
    await ctx.sessions.answerApprovals({ items: [{ sessionId: agentId, requestId: pending!.requestId }], allow: true, remember: true });
    const answer = await waitFor(() => jsonLines<{ behavior: string; updatedPermissions?: unknown[] }>(ctx.answers)[1]);
    expect(answer.behavior).toBe('allow');
    expect(answer.updatedPermissions).toBeUndefined();
    expect(ctx.sessions.rules(parent.id).map((r) => r.rule)).toEqual(['mcp__claude-in-chrome__navigate', 'Bash(pnpm install)']);
  });

  it('denies with the person’s note, or a default one, and reports items no longer waiting', async () => {
    const ctx = setup();
    const { parent } = await roundUp(ctx, 2);
    const [a, b] = ctx.sessions
      .approvals(parent.id)
      .sort((x, y) => x.agentTitle.localeCompare(y.agentTitle))
      .map((p) => ({ sessionId: p.sessionId, requestId: p.requestId }));
    await ctx.sessions.answerApprovals({ items: [a!], allow: false, message: 'Use the lockfile you have.' });
    await ctx.sessions.answerApprovals({ items: [b!], allow: false });
    const answers = await waitFor(() => jsonLines<{ behavior: string; message: string }>(ctx.answers).length === 3 && jsonLines<{ behavior: string; message: string }>(ctx.answers).slice(1));
    // Two processes write their answers, in either order.
    expect(answers).toEqual(
      expect.arrayContaining([
        { behavior: 'deny', message: 'Use the lockfile you have.' },
        { behavior: 'deny', message: DENIED },
      ]),
    );
    const again = await ctx.sessions.answerApprovals({ items: [a!], allow: true });
    expect(again[0]).toMatchObject({ ok: false, error: expect.stringMatching(/no longer waiting/) });
  });

  it('approves a plan only with the mode to carry it out in, and takes the round-up out of plan mode', async () => {
    const ctx = setup(openStore(':memory:'), { FAKE_ASK_TOOL: 'ExitPlanMode', FAKE_ASK: '1. Add sub' });
    const parent = ctx.sessions.create(undefined, { mode: 'plan' });
    await parent.send('Plan it');
    const [plan] = await waitFor(() => ctx.sessions.approvals(parent.id).length === 1 && ctx.sessions.approvals(parent.id));
    expect(plan).toMatchObject({ tool: 'ExitPlanMode', plan: '1. Add sub' });
    const item = { sessionId: plan!.sessionId, requestId: plan!.requestId };
    // Without a mode the round-up would stay in plan mode while the orchestrator went ahead.
    const [refused] = await ctx.sessions.answerApprovals({ items: [item], allow: true });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/needs the mode/) });
    expect(parent.mode).toBe('plan');
    const [approved] = await ctx.sessions.answerApprovals({ items: [item], allow: true, mode: 'acceptEdits' });
    expect(approved!.ok).toBe(true);
    expect(parent.mode).toBe('acceptEdits');
    await waitFor(() => jsonLines<{ behavior: string }>(ctx.answers).some((a) => a.behavior === 'allow'));
  });

  describe('questions', () => {
    const QUESTION = 'Which color should the button be?';
    const asking = () => setup(openStore(':memory:'), { FAKE_ASK_TOOL: 'AskUserQuestion', FAKE_ASK: QUESTION });

    it('puts what an agent asks to the person, and hands their answers back to its harness', async () => {
      const ctx = asking();
      const parent = ctx.sessions.create();
      await parent.send('Go');
      const agent = ctx.sessions.get((await ctx.orch.spawn(parent, { title: 'Picker', task: 'pick', writes: false })).agentId)!;
      // The orchestrator's own question comes to the person too, never to Kelpie's policy.
      const pending = await waitFor(() => ctx.sessions.approvals(parent.id).length === 2 && ctx.sessions.approvals(parent.id));
      const q = pending.find((p) => p.sessionId === agent.id)!;
      expect(q).toMatchObject({
        tool: 'AskUserQuestion',
        title: QUESTION,
        agentTitle: 'Picker',
        questions: [{ question: QUESTION, header: 'Color', options: [{ label: 'Red', description: 'Bold' }, { label: 'Blue', description: 'Calm' }] }],
      });
      expect(q.rule).toBeUndefined();
      expect(agent.summary().status).toBe('needs-approval');
      // The orchestrator and its agents may ask.
      const argv = jsonLines<string[]>(ctx.argsFile);
      expect(argv.every((a) => a[a.indexOf('--tools') + 1]!.split(',').includes('AskUserQuestion'))).toBe(true);

      const item = { sessionId: q.sessionId, requestId: q.requestId };
      // A bare yes, or answers to something else, would tell the agent nothing.
      expect((await ctx.sessions.answerApprovals({ items: [item], allow: true }))[0]).toMatchObject({ ok: false, error: /needs the answers/ });
      expect((await ctx.sessions.answerApprovals({ items: [item], allow: true, answers: { 'Something else?': 'Red' } }))[0]).toMatchObject({ ok: false, error: /not one of the questions/ });
      expect((await ctx.sessions.answerApprovals({ items: [item], allow: true, answers: { [QUESTION]: ['Red', 'Blue'] } }))[0]).toMatchObject({ ok: false, error: /takes one answer/ });

      const [ok] = await ctx.sessions.answerApprovals({ items: [item], allow: true, answers: { [QUESTION]: 'Blue' } });
      expect(ok!.ok).toBe(true);
      const answer = await waitFor(() => jsonLines<{ behavior: string; updatedInput?: { answers?: unknown } }>(ctx.answers).find((a) => a.updatedInput?.answers));
      expect(answer).toMatchObject({ behavior: 'allow', updatedInput: { questions: [{ question: QUESTION }], answers: { [QUESTION]: 'Blue' } } });
      // The log keeps what was chosen, for the chat's summary of it.
      const resolved = await waitFor(() => agent.events().find((e) => e.kind === 'permission.resolved'));
      expect(resolved.kind === 'permission.resolved' && resolved.data).toMatchObject({ decision: 'allow', by: 'person', answers: { [QUESTION]: 'Blue' } });
      await waitFor(() => ctx.sessions.approvals(parent.id).length === 1);
      expect(ctx.sessions.approvals(parent.id).map((p) => p.sessionId)).toEqual([parent.id]);
    });

    it('takes answers over the API, one question at a time, and skips them with a deny', async () => {
      const ctx = asking();
      const parent = ctx.sessions.create();
      await parent.send('Go');
      const [q] = await waitFor(() => ctx.sessions.approvals(parent.id).length === 1 && ctx.sessions.approvals(parent.id));
      const item = { sessionId: q!.sessionId, requestId: q!.requestId };
      const post = (body: unknown) => ctx.app.request('/api/approvals', { method: 'POST', headers: { host: '127.0.0.1:7317', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect((await post({ items: [item], decision: 'allow', answers: { [QUESTION]: 3 } })).status).toBe(400);
      expect((await post({ items: [item, item], decision: 'allow', answers: { [QUESTION]: 'Red' } })).status).toBe(400);
      expect((await post({ items: [item], decision: 'deny', answers: { [QUESTION]: 'Red' } })).status).toBe(400);

      const res = await post({ items: [item], decision: 'deny' });
      expect(((await res.json()) as { results: { ok: boolean }[] }).results[0]!.ok).toBe(true);
      const answer = await waitFor(() => jsonLines<{ behavior: string; message?: string }>(ctx.answers)[0]);
      expect(answer).toEqual({ behavior: 'deny', message: SKIPPED });
      await waitFor(() => ctx.sessions.approvals().length === 0);
    });

    it.each([
      ['cancels it', {}],
      ['says nothing of it', { FAKE_NO_CANCEL: '1' }],
    ])('closes a question when its turn is interrupted and the CLI %s', async (_, env) => {
      const ctx = setup(openStore(':memory:'), { FAKE_ASK_TOOL: 'AskUserQuestion', FAKE_ASK: QUESTION, ...env });
      const parent = ctx.sessions.create();
      await parent.send('Go');
      const [q] = await waitFor(() => ctx.sessions.approvals(parent.id).length === 1 && ctx.sessions.approvals(parent.id));
      await parent.interrupt();
      await waitFor(() => ctx.sessions.approvals().length === 0);
      const resolved = parent.events().filter((e) => e.kind === 'permission.resolved');
      expect(resolved.map((e) => e.kind === 'permission.resolved' && e.data.requestId)).toEqual([q!.requestId]);
      // Answered late, it is reported as missed rather than shown as answered.
      const [late] = await ctx.sessions.answerApprovals({ items: [{ sessionId: q!.sessionId, requestId: q!.requestId }], allow: true, answers: { [QUESTION]: 'Red' } });
      expect(late).toMatchObject({ ok: false, error: expect.stringMatching(/no longer waiting/) });
      expect(jsonLines(ctx.answers)).toEqual([]);
    });

    it('turns down answers sent for something that is not a question', async () => {
      const ctx = setup();
      const { agents } = await roundUp(ctx, 1);
      const [p] = ctx.sessions.approvals().filter((a) => a.sessionId === agents[0]!.id);
      const item = { sessionId: p!.sessionId, requestId: p!.requestId };
      const res = await ctx.app.request('/api/approvals', {
        method: 'POST',
        headers: { host: '127.0.0.1:7317', 'content-type': 'application/json' },
        body: JSON.stringify({ items: [item], decision: 'allow', answers: { 'Which?': 'Red' } }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/not a question/);
      expect((await ctx.sessions.answerApprovals({ items: [item], allow: true, answers: { 'Which?': 'Red' } }))[0]).toMatchObject({ ok: false, error: /not a question/ });
      // Still waiting: nothing was answered.
      expect(ctx.sessions.approvals().some((a) => a.requestId === item.requestId)).toBe(true);
    });

    it('checks a number question against its range, and takes a text question in words', async () => {
      const input = {
        questions: [
          { question: 'Name?', kind: 'text', placeholder: 'kelp' },
          { question: 'Slides?', kind: 'number', min: 3, max: 20, unit: 'slides' },
        ],
      };
      const ctx = setup(openStore(':memory:'), { FAKE_ASK_TOOL: 'AskUserQuestion', FAKE_ASK: QUESTION, FAKE_ASK_INPUT: JSON.stringify(input) });
      const parent = ctx.sessions.create();
      await parent.send('Go');
      const [q] = await waitFor(() => ctx.sessions.approvals(parent.id).length === 1 && ctx.sessions.approvals(parent.id));
      expect(q!.questions).toEqual([
        { question: 'Name?', kind: 'text', placeholder: 'kelp', options: [] },
        { question: 'Slides?', kind: 'number', min: 3, max: 20, unit: 'slides', options: [] },
      ]);
      const item = { sessionId: q!.sessionId, requestId: q!.requestId };
      const answer = (answers: Record<string, string>) => ctx.sessions.answerApprovals({ items: [item], allow: true, answers });
      expect((await answer({ 'Slides?': '40' }))[0]).toMatchObject({ ok: false, error: /between 3 and 20/ });
      expect((await answer({ 'Slides?': 'many' }))[0]).toMatchObject({ ok: false, error: /between 3 and 20/ });
      // Some questions may go unanswered.
      expect((await answer({ 'Slides?': '7' }))[0]!.ok).toBe(true);
      const sent = await waitFor(() => jsonLines<{ updatedInput?: { answers?: unknown } }>(ctx.answers)[0]);
      expect(sent.updatedInput?.answers).toEqual({ 'Slides?': '7' });
    });

    it('lists questions again after a reconnect, and closes them when Kelpie restarts', async () => {
      const store = openStore(':memory:');
      const ctx = setup(store, { FAKE_ASK_TOOL: 'AskUserQuestion', FAKE_ASK: QUESTION });
      const parent = ctx.sessions.create();
      await parent.send('Go');
      await waitFor(() => ctx.sessions.approvals(parent.id).length === 1);
      // What a page that (re)connects is sent.
      const res = await ctx.app.request('/api/approvals', { headers: { host: '127.0.0.1:7317' } });
      expect(((await res.json()) as { approvals: unknown[] }).approvals).toMatchObject([{ tool: 'AskUserQuestion', questions: [{ question: QUESTION }] }]);
      // Kelpie stops while it waits: the next start expires the question and resumes the round-up, whose harness asks again.
      ctx.sessions.prepareShutdown();
      await ctx.sessions.stopAll();
      managers.splice(managers.indexOf(ctx.sessions), 1);
      expect(parent.resumePending).toBe(true);
      const logged = parent.events().filter((e) => e.kind === 'permission.requested');
      expect(logged.map((e) => e.kind === 'permission.requested' && e.data.questions?.[0]?.question)).toEqual([QUESTION]);
      const again = new SessionManager({ store, defaultCwd: tmpdir() });
      managers.push(again);
      const closed = again.get(parent.id)!.events().filter((e) => e.kind === 'permission.resolved');
      expect(closed.map((e) => e.kind === 'permission.resolved' && e.data.by)).toEqual(['expired']);
      expect(again.approvals()).toEqual([]);
    });
  });

  it('checks a batch before answering any of it', async () => {
    const { app } = setup();
    const post = (body: unknown) => app.request('/api/approvals', { method: 'POST', headers: { host: '127.0.0.1:7317', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const item = { sessionId: 'x', requestId: 'y' };
    expect((await post({ items: [], decision: 'allow' })).status).toBe(400);
    expect((await post({ items: [item], decision: 'maybe' })).status).toBe(400);
    expect((await post({ items: [item], decision: 'allow', mode: 'plan' })).status).toBe(400);
    const res = await post({ items: [item], decision: 'allow' });
    expect(((await res.json()) as { results: { ok: boolean }[] }).results[0]!.ok).toBe(false);
  });

  it('marks requests left open by a crash as expired when Kelpie starts again', () => {
    const store = openStore(':memory:');
    store.createSession({ id: 'a', cwd: tmpdir() });
    const ev = (seq: number, kind: string, data: unknown) => ({ id: `r:${seq}`, runId: 'r', seq, ts: '2026-01-01T00:00:00.000Z', harness: 'claude-code', kind, data }) as never;
    // A process that was asking when Kelpie died: its log ends mid-request.
    store.appendEvent('a', 0, ev(0, 'activity', { busy: true }));
    store.appendEvent('a', 1, ev(1, 'permission.requested', { requestId: 'q1', tool: 'Bash', title: 'pnpm install', input: {} }));
    store.appendEvent('a', 2, ev(2, 'permission.requested', { requestId: 'q2', tool: 'Bash', title: 'ls', input: {} }));
    store.appendEvent('a', 3, ev(3, 'permission.resolved', { requestId: 'q2', decision: 'allow', by: 'person' }));
    const sessions = new SessionManager({ store, defaultCwd: tmpdir() });
    const kinds = sessions.get('a')!.events().slice(4).map((e) => (e.kind === 'permission.resolved' ? `${e.kind}:${e.data.requestId}:${e.data.by}` : e.kind));
    expect(kinds).toEqual(['permission.resolved:q1:expired', 'turn.ended', 'activity', 'process.exited']);
    expect(sessions.approvals()).toEqual([]);
  });
});
