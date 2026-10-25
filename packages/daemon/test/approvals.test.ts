import { chmodSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore } from '@kelpie/store';
import { createApp, DENIED, Orchestrator, SessionManager } from '../src/index.js';

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
    expect(ctx.orch.list(parent).agents.map((a) => a.status)).toEqual(['needs approval', 'needs approval']);

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
