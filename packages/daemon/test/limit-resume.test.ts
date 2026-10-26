import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventOf, KelpieEvent } from '@kelpie/protocol';
import { openStore, type Store } from '@kelpie/store';
import { createApp, LIMIT_RESUMED, limitResumed, Orchestrator, SessionManager, type Session } from '../src/index.js';

const FAKE = join(import.meta.dirname, '../../adapters/test/fake-claude.mjs');
const FIXTURE = join(import.meta.dirname, '../../adapters/fixtures/claude-code/plain.jsonl');
chmodSync(FAKE, 0o755);

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOCAL = { host: '127.0.0.1:7317' };
const MESSAGE = "You've hit your session limit · resets 6pm (UTC)";

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

/** A Kelpie whose fake CLI refuses every turn while `limit` (a file) exists, as the real one does at the usage limit. */
function start(opts: { store?: Store; maxAgents?: number; env?: Record<string, string> } = {}) {
  const store = opts.store ?? openStore(':memory:');
  const limit = join(tmp('kelpie-limit-'), 'limit.json');
  const orch = new Orchestrator({ store, mcpUrl: 'http://127.0.0.1:7317/mcp', notifyDelayMs: 50, ...(opts.maxAgents ? { maxAgents: opts.maxAgents } : {}) });
  const sessions = new SessionManager({
    store,
    defaultCwd: tmpdir(),
    runsDir: tmp('kelpie-runs-'),
    defaults: { bin: FAKE, env: { FAKE_FIXTURE: FIXTURE, FAKE_EVERY_TURN: '1', FAKE_LIMIT_FILE: limit, ...opts.env } },
    hooks: orch,
    limitTiming: { bufferMs: 0, staggerMs: 60, probeMs: 3000 },
  });
  orch.attach(sessions);
  managers.push(sessions);
  const hit = (resetsInMs: number) => writeFileSync(limit, JSON.stringify({ resetsAt: Math.ceil((Date.now() + resetsInMs) / 1000), text: MESSAGE }));
  const lift = () => rmSync(limit, { force: true });
  const app = createApp(sessions, { orchestrator: orch });
  return { store, orch, sessions, hit, lift, app };
}

const agent = (sessions: SessionManager, parent: Session, title: string) => sessions.create(tmpdir(), { parentId: parent.id, role: 'agent', title });
const sent = (s: Session) => s.events().filter((e): e is EventOf<'message'> => e.kind === 'message' && !!e.data.sent);
const resumes = (s: Session) => sent(s).filter((e) => e.data.resumed === 'limit');
const turns = (s: Session) => s.events().filter((e): e is EventOf<'turn.ended'> => e.kind === 'turn.ended');
const idle = (s: Session) => !s.working;

// Real (fake-CLI) processes and real reset times, whole seconds as the CLI reports them: more than vitest's 5s default.
describe('resuming after the usage limit', { timeout: 20_000 }, () => {
  it('pauses an agent at the limit, keeps its orchestrator out of it, and resumes it after the reset', async () => {
    const { sessions, hit, lift } = start();
    const orch = sessions.create(tmpdir(), { title: 'Round-up' });
    const a = agent(sessions, orch, 'Checkout API');
    hit(1500);
    await a.send('Build the checkout API', 'orchestrator');
    const paused = await waitFor(() => a.limited);
    expect(paused).toMatchObject({ message: MESSAGE, attempts: 0 });
    expect(paused.retryAt).toBe(paused.resetsAt);
    await waitFor(() => idle(a));
    expect(a.summary()).toMatchObject({ status: 'paused', limited: { message: MESSAGE } });
    expect(a.info().limited).toEqual(paused);
    // The failed turn's log entry says it stopped at the limit, and when Kelpie picks it up.
    expect(turns(a).at(-1)!.data).toMatchObject({ status: 'failed', error: MESSAGE, limit: { window: 'five_hour', retryAt: new Date(paused.retryAt!).toISOString(), attempts: 0 } });
    // Not news for the orchestrator: it will pick up on its own.
    await sleep(300);
    expect(sent(orch)).toHaveLength(0);

    lift();
    sessions.startLimits();
    await waitFor(() => resumes(a).length === 1 && turns(a).at(-1)?.data.status === 'completed');
    expect(resumes(a)[0]!.data).toMatchObject({ text: LIMIT_RESUMED, source: 'kelpie', resumed: 'limit' });
    expect(a.limited).toBeUndefined();
    // Done now: the orchestrator hears, as for any agent that finished.
    // (The fake CLI echoes its fixture's words for a first turn: what was sent is in the notification's agents.)
    const note = await waitFor(() => sent(orch).find((m) => m.data.source === 'kelpie'));
    expect(note.data.agents).toEqual([expect.objectContaining({ agentId: a.id, title: 'Checkout API', status: 'completed' })]);
  });

  it('probes with one agent first, and reschedules the rest when it hits the limit again', async () => {
    const { sessions, hit, lift } = start();
    const orch = sessions.create(tmpdir(), { title: 'Round-up' });
    const agents = ['A', 'B', 'C'].map((t) => agent(sessions, orch, t));
    hit(800);
    await Promise.all(agents.map((s) => s.send(`Do ${s.title}`, 'orchestrator')));
    await waitFor(() => agents.every((s) => s.limited && idle(s)));
    // Still limited at the reset: only the probe finds out, and it says when to try next.
    hit(1500);
    sessions.startLimits();
    await waitFor(() => agents.some((s) => s.limited?.attempts === 1));
    const [probe, ...rest] = [...agents].sort((x, y) => (y.limited!.attempts - x.limited!.attempts));
    // (Which one goes first depends on which paused first: they were all made in the same millisecond.)
    expect(agents.filter((s) => s.limited!.attempts === 1)).toEqual([probe]);
    expect(resumes(probe!)).toHaveLength(1);
    for (const s of rest) {
      expect(resumes(s)).toHaveLength(0);
      expect(s.limited).toMatchObject({ attempts: 0, retryAt: probe!.limited!.retryAt });
    }
    // Then it lifts: the probe gets through, and the others follow.
    lift();
    await waitFor(() => agents.every((s) => !s.limited && turns(s).at(-1)?.data.status === 'completed'));
    expect(resumes(probe!)).toHaveLength(2);
    for (const s of rest) expect(resumes(s)).toHaveLength(1);
  });

  it('resumes agents no faster than the agent limit allows', async () => {
    const { sessions, hit, lift, orch: orchestrator } = start({ maxAgents: 2, env: { FAKE_TURN_DELAY: '400' } });
    const orch = sessions.create(tmpdir(), { title: 'Round-up' });
    const agents = ['A', 'B', 'C', 'D'].map((t) => agent(sessions, orch, t));
    hit(500);
    // Two at a time, as the orchestrator would have started them.
    for (const pair of [agents.slice(0, 2), agents.slice(2)]) {
      await Promise.all(pair.map((s) => s.send(`Do ${s.title}`, 'orchestrator')));
      await waitFor(() => pair.every((s) => s.limited && idle(s)));
    }
    lift();
    let most = 0;
    const watch = setInterval(() => (most = Math.max(most, agents.filter((s) => s.working).length)), 5);
    sessions.startLimits();
    try {
      await waitFor(() => agents.every((s) => !s.limited && resumes(s).length === 1 && turns(s).at(-1)?.data.status === 'completed' && idle(s)), 15000);
    } finally {
      clearInterval(watch);
    }
    expect(most).toBe(2);
    expect(orchestrator.maxAgents).toBe(2);
  });

  it('tells the orchestrator which of its agents were paused too when it resumes', async () => {
    const { sessions, hit, lift } = start();
    const orch = sessions.create(tmpdir(), { title: 'Round-up' });
    const a = agent(sessions, orch, 'Checkout API');
    const b = agent(sessions, orch, 'Payments UI');
    hit(600);
    await Promise.all([a, b, orch].map((s) => s.send('Go', s === orch ? 'user' : 'orchestrator')));
    await waitFor(() => [a, b, orch].every((s) => s.limited && idle(s)));
    lift();
    sessions.startLimits();
    // Its first turn's echo was the fixture's: this one is Kelpie's own.
    const note = await waitFor(() => resumes(orch)[0]);
    expect(note.data.text).toBe(limitResumed([{ agentId: a.id, title: 'Checkout API' }, { agentId: b.id, title: 'Payments UI' }]));
    expect(note.data.text).toContain('Your usage limit has reset, so Kelpie resumed you');
    expect(note.data.text).toContain(`"Checkout API" (${a.id}), "Payments UI" (${b.id})`);
    expect(note.data.text).toContain('that is not a failure');
  });

  it('keeps a pause across a restart, and lets the person cancel it or resume now', async () => {
    const db = join(tmp('kelpie-home-'), 'kelpie.db');
    const first = start({ store: openStore(db) });
    const orch = first.sessions.create(tmpdir(), { title: 'Round-up' });
    const a = agent(first.sessions, orch, 'A');
    const b = agent(first.sessions, orch, 'B');
    first.hit(60 * 60_000);
    await Promise.all([a, b].map((s) => s.send('Go', 'orchestrator')));
    await waitFor(() => [a, b].every((s) => s.limited && idle(s)));
    const before = a.limited!;
    first.sessions.prepareShutdown();
    await first.sessions.stopAll();
    first.store.close();

    const second = start({ store: openStore(db) });
    const a2 = second.sessions.get(a.id)!;
    const b2 = second.sessions.get(b.id)!;
    expect(a2.limited).toEqual(before);
    expect(a2.summary().status).toBe('paused');
    second.sessions.startLimits();

    // Don't auto-resume: it stays paused, without a time.
    const cancel = await second.app.request(`/api/sessions/${b2.id}/limit/cancel`, { method: 'POST', headers: { ...LOCAL, 'content-type': 'application/json' }, body: '{}' });
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as { limited: object }).limited).not.toHaveProperty('retryAt');
    // An interrupt does the same.
    await a2.interrupt();
    expect(a2.limited!.retryAt).toBeUndefined();

    // Resume now: tried at once; it gets through, and the other follows only if it is to resume on its own.
    second.lift();
    const now = await second.app.request(`/api/sessions/${a2.id}/limit/resume`, { method: 'POST', headers: { ...LOCAL, 'content-type': 'application/json' }, body: '{}' });
    expect(now.status).toBe(202);
    await waitFor(() => !a2.limited && turns(a2).at(-1)?.data.status === 'completed');
    await sleep(300);
    expect(resumes(b2)).toHaveLength(0);
    expect(b2.limited).toBeDefined();
    const again = await second.app.request(`/api/sessions/${a2.id}/limit/resume`, { method: 'POST', headers: { ...LOCAL, 'content-type': 'application/json' }, body: '{}' });
    expect(again.status).toBe(409);
  });

  it('lets the orchestrator see paused agents, and hears of one that will not resume on its own', async () => {
    const { sessions, hit, orch: orchestrator } = start();
    const orch = sessions.create(tmpdir(), { title: 'Round-up' });
    const a = agent(sessions, orch, 'Checkout API');
    hit(60 * 60_000);
    await a.send('Go', 'orchestrator');
    await waitFor(() => a.limited && idle(a));
    const list = await orchestrator.list(orch);
    expect(list.agents[0]).toMatchObject({ status: 'paused', resumesAt: new Date(a.limited!.retryAt!).toISOString() });
    await sleep(200);
    expect(sent(orch)).toHaveLength(0);
    sessions.limits.cancel(a.id);
    const note = await waitFor(() => sent(orch).find((m) => m.data.source === 'kelpie'));
    expect(note.data.agents).toEqual([expect.objectContaining({ title: 'Checkout API', status: 'paused at the usage limit (the person can resume it)', error: MESSAGE })]);
    expect((await orchestrator.list(orch)).agents[0]).not.toHaveProperty('resumesAt');
  });
});

describe('cancelling a paused round-up', { timeout: 20_000 }, () => {
  it("stops its agents resuming too, and holds the orchestrator's notices until its own pause is over", async () => {
    const { sessions, hit, lift, app } = start();
    const orch = sessions.create(tmpdir(), { title: 'Round-up' });
    const a = agent(sessions, orch, 'Checkout API');
    const b = agent(sessions, orch, 'Payments UI');
    hit(60 * 60_000);
    await Promise.all([a, b, orch].map((s) => s.send('Go', s === orch ? 'user' : 'orchestrator')));
    await waitFor(() => [a, b, orch].every((s) => s.limited && idle(s)));
    const before = sent(orch).length;

    // Don't auto-resume, on the round-up: its agents wait for the person too.
    const res = await app.request(`/api/sessions/${orch.id}/limit/cancel`, { method: 'POST', headers: { ...LOCAL, 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);
    for (const s of [orch, a, b]) expect(s.limited!.retryAt).toBeUndefined();
    // They won't resume on their own now: news for the orchestrator, but held while it is paused itself.
    await sleep(300);
    expect(sent(orch)).toHaveLength(before);

    // The person picks the orchestrator up once the limit lifts: what was held goes to it.
    lift();
    expect(sessions.limits.resumeNow(orch.id)).toBe(true);
    await waitFor(() => !orch.limited);
    const note = await waitFor(() => sent(orch).find((m) => m.data.agents?.length));
    expect(note.data.agents!.map((x) => x.title).sort()).toEqual(['Checkout API', 'Payments UI']);
    expect(resumes(a)).toHaveLength(0);
  });

  it('an interrupt of a paused round-up cancels its agents too; an agent\'s own, only its own', async () => {
    const { sessions, hit } = start();
    const orch = sessions.create(tmpdir(), { title: 'Round-up' });
    const a = agent(sessions, orch, 'A');
    const b = agent(sessions, orch, 'B');
    hit(60 * 60_000);
    await Promise.all([a, b, orch].map((s) => s.send('Go', s === orch ? 'user' : 'orchestrator')));
    await waitFor(() => [a, b, orch].every((s) => s.limited && idle(s)));
    await a.interrupt();
    expect(a.limited!.retryAt).toBeUndefined();
    expect(b.limited!.retryAt).toBeDefined();
    expect(orch.limited!.retryAt).toBeDefined();
    await orch.interrupt();
    expect(b.limited!.retryAt).toBeUndefined();
    expect(orch.limited!.retryAt).toBeUndefined();
  });
});

// Keeps the KelpieEvent import used for readers of these helpers' types.
export type { KelpieEvent };
