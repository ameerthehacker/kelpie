import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_HALT_RESUMED, type EventOf } from '@kelpie/protocol';
import { openStore, type Store } from '@kelpie/store';
import { createApp, HALTED, Orchestrator, SessionManager, type Session } from '../src/index.js';

const FAKE = join(import.meta.dirname, '../../adapters/test/fake-claude.mjs');
const FIXTURE = join(import.meta.dirname, '../../adapters/fixtures/claude-code/plain.jsonl');
chmodSync(FAKE, 0o755);

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOCAL = { host: '127.0.0.1:7317', 'content-type': 'application/json' };

async function waitFor<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
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

interface Received {
  resume: string | null;
  text: string;
}
const received = (file: string): Received[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Received)
    : [];

/**
 * A Kelpie on the fake CLI whose first turns take `slow` ms (until interrupted), later ones `delay` ms.
 * `limit` (a file) makes every turn hit the usage limit while it exists.
 */
function start(opts: { store?: Store; maxAgents?: number; slow?: number; delay?: number; stdin?: string } = {}) {
  const store = opts.store ?? openStore(':memory:');
  const limit = join(tmp('kelpie-limit-'), 'limit.json');
  const orch = new Orchestrator({ store, mcpUrl: 'http://127.0.0.1:7317/mcp', notifyDelayMs: 50, ...(opts.maxAgents ? { maxAgents: opts.maxAgents } : {}) });
  const env: Record<string, string> = { FAKE_FIXTURE: FIXTURE, FAKE_EVERY_TURN: '1', FAKE_LIMIT_FILE: limit, FAKE_SLOW: String(opts.slow ?? 30_000), FAKE_TURN_DELAY: String(opts.delay ?? 0) };
  if (opts.stdin) env.FAKE_STDIN_FILE = opts.stdin;
  const sessions = new SessionManager({ store, defaultCwd: tmpdir(), runsDir: tmp('kelpie-runs-'), defaults: { bin: FAKE, env }, hooks: orch, limitTiming: { bufferMs: 0, staggerMs: 60, probeMs: 3000 } });
  orch.attach(sessions);
  managers.push(sessions);
  const hit = (resetsInMs: number) => writeFileSync(limit, JSON.stringify({ resetsAt: Math.ceil((Date.now() + resetsInMs) / 1000) }));
  const lift = () => rmSync(limit, { force: true });
  return { store, orch, sessions, hit, lift, app: createApp(sessions, { orchestrator: orch }) };
}

const agent = (sessions: SessionManager, parent: Session, title: string, id?: string) =>
  sessions.create(tmpdir(), { parentId: parent.id, role: 'agent', title, ...(id ? { id } : {}) });
const sent = (s: Session) => s.events().filter((e): e is EventOf<'message'> => e.kind === 'message' && !!e.data.sent);
const turns = (s: Session) => s.events().filter((e): e is EventOf<'turn.ended'> => e.kind === 'turn.ended');
const halts = (s: Session) => s.events().filter((e): e is EventOf<'halt'> => e.kind === 'halt').map((e) => e.data);

describe('Stop all and Resume all', { timeout: 20_000 }, () => {
  it('stops every working agent and the orchestrator, cancels auto-resume, and refuses the orchestrator until resumed', async () => {
    const stdin = join(tmp('kelpie-stdin-'), 'stdin.jsonl');
    const { sessions, orch: o, hit, lift } = start({ stdin });
    const orch = sessions.create(tmpdir(), { title: 'Round-up' });
    const [a, b, c, idle] = ['A', 'B', 'C', 'Idle'].map((t) => agent(sessions, orch, t));
    // C is paused at the usage limit, due to resume on its own in a minute.
    hit(60_000);
    await c!.send('Do C', 'orchestrator');
    await waitFor(() => c!.limited && !c!.working);
    lift();
    sessions.startLimits();
    expect(sessions.limits.willResume(c!.id)).toBe(true);
    await orch.send('Plan it', 'user');
    await a!.send('Do A', 'orchestrator');
    await b!.send('Do B', 'orchestrator');
    await waitFor(() => a!.busy && b!.busy && orch.busy);

    const result = await o.stopAll(orch);
    expect(result).toEqual({ agents: expect.arrayContaining([a!.id, b!.id, c!.id]), orchestrator: true });
    expect(result.agents).toHaveLength(3);
    await waitFor(() => !a!.working && !b!.working && !orch.working);
    for (const s of [a!, b!]) expect(turns(s).at(-1)!.data.status).toBe('interrupted');
    for (const s of [a!, b!, c!]) {
      expect(s.halted).toBeTypeOf('number');
      expect(s.summary().status).toBe('halted');
    }
    // One that had nothing going is left alone.
    expect(idle!.halted).toBeUndefined();
    expect(sessions.limits.willResume(c!.id)).toBe(false);
    expect(orch.info().halted).toBeTypeOf('number');
    expect(halts(orch)).toEqual([{ action: 'stopped', agents: 3, orchestrator: true }]);
    expect((await o.list(orch)).agents.find((x) => x.agentId === a!.id)?.status).toBe('stopped by the person');

    // Refused, with the reason, until the person resumes.
    await expect(o.spawn(orch, { title: 'New', task: 'Do more', writes: false })).rejects.toThrow(HALTED);
    await expect(o.message(orch, idle!.id, 'Carry on')).rejects.toThrow(HALTED);
    expect(sessions.children(orch.id)).toHaveLength(4);

    // Nothing wakes it: the agents' stopped turns are not news while it is stopped.
    await sleep(300);
    expect(sent(orch).filter((m) => m.data.source === 'kelpie')).toHaveLength(0);
    // It hears with its next turn, the person's own, once.
    await orch.send('What happened?', 'user');
    await waitFor(() => !orch.working && turns(orch).at(-1)?.data.status === 'completed');
    await orch.send('And now?', 'user');
    await waitFor(() => received(stdin).filter((r) => r.text.startsWith('And now?')).length === 1);
    const toOrch = received(stdin).filter((r) => r.text.startsWith('What happened?') || r.text.startsWith('And now?'));
    expect(toOrch[0]!.text).toContain('The person stopped all your agents');
    expect(toOrch[0]!.text).toContain(`"A" (${a!.id})`);
    expect(toOrch[1]!.text).toBe('And now?');
  });

  it('resumes exactly what it stopped, as far as the agent limit allows, and tells the orchestrator once', async () => {
    const stdin = join(tmp('kelpie-stdin-'), 'stdin.jsonl');
    const { sessions, orch: o } = start({ maxAgents: 2, delay: 400, stdin });
    const orch = sessions.create(tmpdir(), { title: 'Round-up' });
    const agents = ['A', 'B', 'C'].map((t) => agent(sessions, orch, t));
    for (const s of agents) await s.send(`Do ${s.title}`, 'orchestrator');
    await waitFor(() => agents.every((s) => s.busy));
    await o.stopAll(orch);
    await waitFor(() => agents.every((s) => !s.working));

    const { resumed, queued } = await o.resumeAll(orch);
    expect(resumed.sort()).toEqual(agents.map((s) => s.id).sort());
    expect(queued).toHaveLength(1);
    expect(agents.filter((s) => s.working)).toHaveLength(2);
    expect(sessions.get(queued[0]!)!.summary()).toMatchObject({ queued: true });
    expect(orch.halted).toBeUndefined();
    for (const s of agents) expect(s.halted).toBeUndefined();
    expect(halts(orch)).toEqual([
      { action: 'stopped', agents: 3 },
      { action: 'resumed', agents: 3 },
    ]);
    // The third goes once a slot frees up; each continues with the same short prompt.
    await waitFor(() => agents.every((s) => sent(s).some((m) => m.data.resumed === 'halt')));
    for (const s of agents) expect(sent(s).find((m) => m.data.resumed === 'halt')!.data).toMatchObject({ text: AGENT_HALT_RESUMED, source: 'kelpie' });
    await waitFor(() => agents.every((s) => turns(s).at(-1)?.data.status === 'completed'));
    const told = received(stdin).filter((r) => r.text.includes('The person resumed this round-up'));
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toContain('1 of them wait');
    expect(sessions.all().every((s) => !s.resumePending)).toBe(true);
  });

  it('resumes one agent on its own, and the last of them resumes the round-up', async () => {
    const { sessions, orch: o, app } = start({ delay: 50 });
    const orch = sessions.create(tmpdir(), { title: 'Round-up' });
    const [a, b] = ['A', 'B'].map((t) => agent(sessions, orch, t));
    for (const s of [a!, b!]) await s.send(`Do ${s.title}`, 'orchestrator');
    await waitFor(() => a!.busy && b!.busy);

    const stop = await app.request(`/api/sessions/${orch.id}/stop-all`, { method: 'POST', headers: LOCAL, body: JSON.stringify({ orchestrator: false }) });
    expect(stop.status).toBe(200);
    expect(await stop.json()).toMatchObject({ orchestrator: false, session: { halted: expect.any(Number) } });
    await waitFor(() => !a!.working && !b!.working);
    // Not the round-up itself, and not one it didn't stop.
    expect((await app.request(`/api/sessions/${a!.id}/stop-all`, { method: 'POST', headers: LOCAL, body: '{}' })).status).toBe(400);
    expect((await app.request(`/api/sessions/${orch.id}/resume`, { method: 'POST', headers: LOCAL, body: '{}' })).status).toBe(400);

    const one = await app.request(`/api/sessions/${a!.id}/resume`, { method: 'POST', headers: LOCAL, body: '{}' });
    expect(one.status).toBe(200);
    expect(a!.halted).toBeUndefined();
    expect(b!.halted).toBeTypeOf('number');
    // The round-up stays stopped while any of its agents is.
    expect(orch.halted).toBeTypeOf('number');
    await waitFor(() => turns(a!).at(-1)?.data.status === 'completed');
    expect((await app.request(`/api/sessions/${a!.id}/resume`, { method: 'POST', headers: LOCAL, body: '{}' })).status).toBe(409);

    const last = await app.request(`/api/sessions/${b!.id}/resume`, { method: 'POST', headers: LOCAL, body: '{}' });
    expect(last.status).toBe(200);
    expect(orch.halted).toBeUndefined();
    expect(halts(orch).map((h) => h.action)).toEqual(['stopped', 'resumed', 'resumed']);
    await waitFor(() => sent(orch).some((m) => m.data.resumed === 'halt'));
    expect((await app.request(`/api/sessions/${orch.id}/resume-all`, { method: 'POST', headers: LOCAL, body: '{}' })).status).toBe(409);
  });

  it('stays stopped across a restart, and resumes after it', async () => {
    const db = join(tmp('kelpie-home-'), 'kelpie.db');
    const stdin = join(tmp('kelpie-stdin-'), 'stdin.jsonl');
    let store = openStore(db);
    const first = start({ store, stdin });
    const orch = first.sessions.create(tmpdir(), { title: 'Round-up', id: 'orch' });
    const [a, b] = ['A', 'B'].map((t) => agent(first.sessions, orch, t, t.toLowerCase()));
    for (const s of [a!, b!]) await s.send(`Do ${s.title}`, 'orchestrator');
    await waitFor(() => a!.busy && b!.busy);
    await first.orch.stopAll(orch);
    await waitFor(() => !a!.working && !b!.working);
    first.sessions.prepareShutdown();
    await first.sessions.stopAll();
    store.close();

    store = openStore(db);
    const before = received(stdin).length;
    const second = start({ store, stdin, delay: 50, slow: 50 });
    await second.orch.recover();
    await sleep(300);
    expect(received(stdin)).toHaveLength(before);
    const [orch2, a2, b2] = ['orch', 'a', 'b'].map((id) => second.sessions.get(id)!);
    for (const s of [orch2!, a2!, b2!]) expect(s.halted).toBeTypeOf('number');
    expect(a2!.summary().status).toBe('halted');
    await expect(second.orch.spawn(orch2!, { title: 'New', task: 'Do more', writes: false })).rejects.toThrow(HALTED);

    await second.orch.resumeAll(orch2!);
    await waitFor(() => [a2!, b2!].every((s) => turns(s).at(-1)?.data.status === 'completed' && sent(s).some((m) => m.data.resumed === 'halt')));
    expect(store.haltOf('a')).toBeUndefined();
  });
});
