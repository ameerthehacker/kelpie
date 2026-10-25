import { chmodSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import { openStore, type Store } from '@kelpie/store';
import { Orchestrator, Session, SessionManager } from '../src/index.js';

const FAKE = join(import.meta.dirname, '../../adapters/test/fake-claude.mjs');
const FIXTURE = join(import.meta.dirname, '../../adapters/fixtures/claude-code/plain.jsonl');
chmodSync(FAKE, 0o755);

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jsonLines = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

async function waitFor<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}

type Received = { resume: string | null; text: string };

const managers: SessionManager[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(managers.splice(0).map((m) => m.stopAll()));
});

function start(store: Store, env: Record<string, string>) {
  const orch = new Orchestrator({ store, mcpUrl: 'http://127.0.0.1:7317/mcp', notifyDelayMs: 50 });
  const sessions = new SessionManager({
    store,
    defaultCwd: tmpdir(),
    runsDir: tmp('kelpie-runs-'),
    defaults: { bin: FAKE, env: { FAKE_FIXTURE: FIXTURE, ...env } },
    hooks: orch,
  });
  orch.attach(sessions);
  managers.push(sessions);
  return { orch, sessions };
}

const base = { ts: '2026-01-01T00:00:00.000Z', harness: 'claude-code' as const };

/** A round-up's log as a killed daemon left it: a turn sent and taken in, then mid-work. */
function midWork(store: Store, id: string, text: string) {
  const runId = `run-${id}`;
  const log = [
    { ...base, runId, id: `${id}0`, seq: 0, kind: 'activity', data: { busy: true } },
    { ...base, runId, id: `${id}1`, seq: 1, kind: 'message', data: { role: 'user', text, sent: true } },
    { ...base, runId, id: `${id}2`, seq: 2, kind: 'tool.started', data: { callId: 'c', name: 'Bash', category: 'bash', title: 'pnpm test', input: {} } },
  ] as KelpieEvent[];
  store.atomically(() => {
    const row = store.enqueue(id, text, id === 'orch' ? 'user' : 'orchestrator');
    log.forEach((e, i) => store.appendEvent(id, i, e, 1000, e.kind === 'message' ? row.id : undefined));
  });
}

describe('recovery after Kelpie stops', () => {
  it('shows a cut-off agent as stopped, with its own todos and not a sub-agent’s', () => {
    const store = openStore(':memory:');
    store.createSession({ id: 'orch', cwd: tmpdir(), title: 'RCA' }, 1000);
    store.createSession({ id: 'a', cwd: tmpdir(), title: 'A', parentId: 'orch', role: 'agent' }, 1000);
    midWork(store, 'a', 'Investigate ticket 1');
    const todos = (id: string, text: string, parentCallId?: string) =>
      ({ ...base, runId: 'run-a', id, seq: 3, kind: 'todos', ...(parentCallId ? { parentCallId } : {}), data: { items: [{ id: '1', text, status: 'in_progress' }] } }) as KelpieEvent;
    store.appendEvent('a', 3, todos('a3', 'Read the logs'));
    store.appendEvent('a', 4, todos('a4', 'Nested agent step', 'sub'));
    const { sessions } = start(store, {});
    expect(sessions.get('a')!.summary()).toMatchObject({ status: 'stopped', now: 'Stopped.', todos: [{ text: 'Read the logs' }] });
  });

  it('resumes agents and orchestrators that a crash cut off, and re-sends turns never taken in', async () => {
    const db = join(tmp('kelpie-home-'), 'kelpie.db');
    const stdin = join(tmp('kelpie-stdin-'), 'stdin.jsonl');
    let store = openStore(db);
    store.createSession({ id: 'orch', cwd: tmpdir(), title: 'RCA', harnessSessionId: 'h-orch' }, 1000);
    store.createSession({ id: 'a', cwd: tmpdir(), title: 'A', parentId: 'orch', role: 'agent', harnessSessionId: 'h-a' }, 1000);
    store.createSession({ id: 'b', cwd: tmpdir(), title: 'B', parentId: 'orch', role: 'agent', harnessSessionId: 'h-b' }, 1000);
    store.createSession({ id: 'c', cwd: tmpdir(), title: 'C', parentId: 'orch', role: 'agent', harnessSessionId: 'h-c' }, 1000);
    midWork(store, 'orch', 'RCA these tickets');
    midWork(store, 'a', 'Investigate ticket 1');
    midWork(store, 'b', 'Investigate ticket 2');
    // C was idle, but a follow-up from the orchestrator was written and never reached it.
    store.appendEvent('c', 0, { ...base, runId: 'run-c', id: 'c0', seq: 0, kind: 'process.exited', data: { code: 0, signal: null, stderrTail: '' } } as KelpieEvent);
    store.enqueue('c', 'Also check ticket 3', 'orchestrator');
    store.close();

    store = openStore(db);
    const { orch, sessions } = start(store, { FAKE_STDIN_FILE: stdin, FAKE_EVERY_TURN: '1' });
    expect(store.getSession('a')!.resumePending).toBe(true); // repair() marked what the crash cut off
    const resumes = vi.spyOn(Session.prototype, 'resumeAfterRestart');
    await orch.recover();
    // Sub-agents first, then their orchestrator. (Not by what each process read first: they start side by side.)
    const order = resumes.mock.contexts.map((s) => (s as Session).id);
    expect(order.at(-1)).toBe('orch');
    expect(order.slice(0, -1).sort()).toEqual(['a', 'b', 'c']);

    const got = await waitFor(() => {
      const r = jsonLines<Received>(stdin);
      return r.length >= 4 && r;
    });
    expect(got).toEqual(
      expect.arrayContaining([
        { resume: 'h-a', text: expect.stringContaining('Kelpie restarted while you were working') },
        { resume: 'h-b', text: expect.stringContaining('Kelpie restarted while you were working') },
        { resume: 'h-c', text: 'Also check ticket 3' },
        { resume: 'h-orch', text: expect.stringContaining('Call list_agents to pick your state back up') },
      ]),
    );

    // Once the resumed agents finish, the orchestrator hears about all three, once.
    await waitFor(() => sessions.get('orch')!.events().some((e) => e.kind === 'message' && e.data.sent && e.data.text.includes('"C"')));
    await waitFor(() => !sessions.all().some((s) => s.working));
    await sleep(200);
    const told = jsonLines<Received>(stdin)
      .filter((r) => r.resume === 'h-orch' || r.text.startsWith('<kelpie-notification>'))
      .map((r) => r.text)
      .join('\n');
    for (const title of ['A', 'B', 'C']) expect(told.split(`Agent "${title}"`).length - 1).toBe(1);
    for (const id of ['orch', 'a', 'b', 'c']) {
      expect(store.undelivered(id)).toEqual([]);
      expect(store.getSession(id)!.resumePending).toBe(false);
    }

    // A second restart has nothing left to do.
    await sessions.stopAll();
    const before = jsonLines<Received>(stdin).length;
    const again = start(store, { FAKE_STDIN_FILE: stdin, FAKE_EVERY_TURN: '1' });
    await again.orch.recover();
    await sleep(300);
    expect(jsonLines<Received>(stdin).length).toBe(before);
  });

  it('resumes what was working at a graceful shutdown', async () => {
    const db = join(tmp('kelpie-home-'), 'kelpie.db');
    const stdin = join(tmp('kelpie-stdin-'), 'stdin.jsonl');
    let store = openStore(db);
    const first = start(store, { FAKE_HANG: '1' });
    const orchSession = first.sessions.create();
    await orchSession.send('Fix it');
    const agent = first.sessions.create(tmpdir(), { parentId: orchSession.id, role: 'agent', writes: true, title: 'Fixer' });
    await agent.send('Fix the bug in x.ts', 'orchestrator');
    await waitFor(() => agent.info().harnessSessionId);

    first.sessions.prepareShutdown();
    await first.sessions.stopAll();
    managers.length = 0;
    store.close();

    store = openStore(db);
    const second = start(store, { FAKE_STDIN_FILE: stdin, FAKE_EVERY_TURN: '1' });
    await second.orch.recover();
    const got = await waitFor(() => {
      const r = jsonLines<Received>(stdin);
      return r.length >= 2 && r;
    });
    const hs = store.getSession(agent.id)!.harnessSessionId;
    expect(got).toContainEqual({ resume: hs, text: expect.stringContaining('Kelpie restarted while you were working') });
    expect(got.filter((r) => r.text.includes('Call list_agents'))).toHaveLength(1);
  });

  it('resumes browser agents with the browser after a restart, one at a time', async () => {
    const db = join(tmp('kelpie-home-'), 'kelpie.db');
    const argsFile = join(tmp('kelpie-args-'), 'args.jsonl');
    let store = openStore(db);
    const first = start(store, { FAKE_HANG: '1' });
    const orchSession = first.sessions.create();
    await orchSession.send('Read the artifacts');
    // Made directly, so both run: the orchestrator's tools would start only one.
    const agents = ['One', 'Two'].map((title) => first.sessions.create(tmpdir(), { parentId: orchSession.id, role: 'agent', browser: true, title }));
    for (const a of agents) await a.send(`Read artifact ${a.title}`, 'orchestrator');
    await waitFor(() => agents.every((a) => a.info().harnessSessionId));

    first.sessions.prepareShutdown();
    await first.sessions.stopAll();
    managers.length = 0;
    store.close();

    store = openStore(db);
    const second = start(store, { FAKE_HANG: '1', FAKE_ARGS_FILE: argsFile });
    expect(agents.map((a) => second.sessions.get(a.id)!.browser)).toEqual([true, true]);
    await second.orch.recover();
    // The orchestrator's own start is the one with the kelpie MCP server.
    const agentArgs = () => jsonLines<string[]>(argsFile).filter((a) => !a.includes('--mcp-config'));
    const [resumed] = await waitFor(() => agentArgs().length > 0 && agentArgs());
    await sleep(300);
    // The first is back in the browser; the other waits for it rather than share it.
    expect(agentArgs()).toHaveLength(1);
    expect(resumed).toContain('--chrome');
    const hs = agents.map((a) => store.getSession(a.id)!.harnessSessionId);
    expect(hs).toContain(resumed![resumed!.indexOf('--resume') + 1]);
    const parent = second.sessions.get(orchSession.id)!;
    expect((await second.orch.list(parent)).agents.map((a) => a.status).sort()).toEqual(['waiting', 'working']);
  });

  it('drops a turn its process died before reading, instead of retrying it forever', async () => {
    const store = openStore(':memory:');
    const { sessions } = start(store, {});
    const s = sessions.create(tmpdir(), {});
    const bad = new SessionManager({ store, defaultCwd: tmpdir(), runsDir: tmp('kelpie-runs-'), defaults: { bin: '/nonexistent/claude' } });
    const session = bad.get(s.id)!;
    await session.send('never read');
    await waitFor(() => session.events().some((e) => e.kind === 'process.exited'));
    expect(store.undelivered(s.id)).toEqual([]);
    expect(session.events().find((e) => e.kind === 'turn.ended')!.data).toMatchObject({ status: 'failed' });
  });

  it('does not leave an agent waiting when its resumed process dies before reading its turn', async () => {
    const store = openStore(':memory:');
    store.createSession({ id: 'orch', cwd: tmpdir(), title: 'RCA' }, 1000);
    store.createSession({ id: 'a', cwd: tmpdir(), title: 'A', parentId: 'orch', role: 'agent', harnessSessionId: 'h-a' }, 1000);
    midWork(store, 'a', 'Investigate ticket 1');
    const orch = new Orchestrator({ store, mcpUrl: 'http://127.0.0.1:7317/mcp', notifyDelayMs: 50 });
    const sessions = new SessionManager({ store, defaultCwd: tmpdir(), runsDir: tmp('kelpie-runs-'), defaults: { bin: '/nonexistent/claude' }, hooks: orch });
    orch.attach(sessions);
    managers.push(sessions);
    await orch.recover();
    const agent = sessions.get('a')!;
    await waitFor(() => agent.events().filter((e) => e.kind === 'process.exited').length === 2);
    expect(store.getSession('a')!.resumePending).toBe(false);
    expect((await orch.list(sessions.get('orch')!)).agents[0]!.status).toBe('idle');
    // The orchestrator is told (its own process can't start here either, so the turn is then dropped).
    await waitFor(() => store.getSession('a')!.notifiedIdx > 0);
  });

  it('starts an agent afresh with its original brief when its session cannot be resumed', async () => {
    const store = openStore(':memory:');
    const argsFile = join(tmp('kelpie-args-'), 'args.jsonl');
    store.createSession({ id: 'orch', cwd: tmpdir(), title: 'RCA' }, 1000);
    store.createSession({ id: 'a', cwd: tmpdir(), title: 'A', parentId: 'orch', role: 'agent', harnessSessionId: 'gone' }, 1000);
    midWork(store, 'a', 'Investigate ticket 1');
    const { orch, sessions } = start(store, { FAKE_RESUME_FAIL: '1', FAKE_ARGS_FILE: argsFile });
    await orch.recover();
    const fresh = await waitFor(() => jsonLines<string[]>(argsFile).find((a) => !a.includes('--resume')));
    const prompt = fresh[fresh.indexOf('--append-system-prompt') + 1]!;
    expect(prompt).toContain('restart you in a new session');
    expect(prompt).toContain('Investigate ticket 1');
    await waitFor(() => store.undelivered('a').length === 0);
    expect(sessions.get('a')!.info().harnessSessionId).toBeTruthy();
  });
});
