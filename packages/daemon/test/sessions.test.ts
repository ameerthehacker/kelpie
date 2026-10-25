import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EventKind, KelpieEvent } from '@kelpie/protocol';
import { openStore, type Store } from '@kelpie/store';
import { SessionManager, titleFrom, type Session, type SessionManagerOptions } from '../src/index.js';

const FAKE = join(import.meta.dirname, '../../adapters/test/fake-claude.mjs');
const FIXTURE = join(import.meta.dirname, '../../adapters/fixtures/claude-code/plain.jsonl');
chmodSync(FAKE, 0o755);

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

function manager(store: Store, env: Record<string, string> = {}, opts: Partial<SessionManagerOptions> = {}) {
  return new SessionManager({
    store,
    defaultCwd: tmpdir(),
    runsDir: tmp('kelpie-runs-'),
    defaults: { bin: FAKE, env: { FAKE_FIXTURE: FIXTURE, ...env } },
    ...opts,
  });
}

/** Resolves with the session's log once an event of `kind` arrives at or after `from`. */
function until(session: Session, kind: EventKind, from = 0): Promise<KelpieEvent[]> {
  return new Promise((resolve) => {
    const log: KelpieEvent[] = [];
    const stop = session.subscribe(({ index, event }) => {
      log[index] = event;
      if (index >= from && event.kind === kind) {
        queueMicrotask(() => stop());
        resolve(log);
      }
    });
  });
}

const argsOf = (file: string): string[][] => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('persistent round-ups', () => {
  it('survive a daemon restart with their log, title and harness session, and resume it', async () => {
    const db = join(tmp('kelpie-home-'), 'kelpie.db');
    const argsFile = join(tmp('kelpie-args-'), 'args.jsonl');

    let store = openStore(db);
    let sessions = manager(store, { FAKE_ARGS_FILE: argsFile });
    const created = sessions.create();
    created.send('What is 2+2?\nThanks');
    const before = await until(created, 'turn.ended');
    await until(created, 'activity', before.length); // the turn's last event: idle again
    const lastActive = created.info().updatedAt;
    await sessions.stopAll();
    expect(created.info().updatedAt).toBe(lastActive); // stopping the process is not activity
    const firstInfo = created.info();
    store.close();

    store = openStore(db);
    sessions = manager(store, { FAKE_ARGS_FILE: argsFile });
    const [info] = sessions.list();
    expect(info).toMatchObject({ id: created.id, title: 'What is 2+2?', busy: false, lastTurn: 'completed' });
    expect(info!.harnessSessionId).toBeTruthy();
    expect(info!.harnessSessionId).toBe(firstInfo.harnessSessionId);

    const reloaded = sessions.get(created.id)!;
    const replay = await until(reloaded, 'process.exited');
    expect(replay.slice(0, before.length)).toEqual(before); // same events at the same indices
    expect(replay.at(-1)!.kind).toBe('process.exited'); // the clean stop was logged before shutdown

    const next = replay.length;
    reloaded.send('And 3+3?');
    await until(reloaded, 'turn.ended', next);
    await sessions.stopAll();
    const [first, second] = argsOf(argsFile);
    expect(first).not.toContain('--resume');
    expect(second!.slice(second!.indexOf('--resume'), second!.indexOf('--resume') + 2)).toEqual(['--resume', info!.harnessSessionId]);
    store.close();
  });

  it('keeps tracking the todo list after a daemon restart resumes the session', async () => {
    const db = join(tmp('kelpie-home-'), 'kelpie.db');
    const todos = join(import.meta.dirname, '../../adapters/fixtures/claude-code/todos.jsonl');
    // The resumed CLI only updates the tasks: it created them before the restart.
    const raw = readFileSync(todos, 'utf8').split('\n').filter(Boolean);
    const created = raw.flatMap((l) => JSON.parse(l).message?.content ?? []).filter((b: any) => b.name === 'TaskCreate').map((b: any) => b.id);
    const resumed = join(tmp('kelpie-fixture-'), 'resumed.jsonl');
    writeFileSync(resumed, raw.filter((l) => !created.some((id: string) => l.includes(id))).join('\n'));

    let store = openStore(db);
    let sessions = manager(store, { FAKE_FIXTURE: todos });
    const session = sessions.create();
    session.send('Make a plan');
    await until(session, 'turn.ended');
    await sessions.stopAll();
    store.close();
    // As if the restart cut it off before the tasks were done.
    store = openStore(db);
    store.appendEvent(session.id, store.eventCount(session.id), {
      id: 'x:0', runId: 'x', seq: 0, ts: new Date().toISOString(), harness: 'claude-code', kind: 'todos',
      data: { items: [{ id: '1', text: 'Count lines', status: 'pending' }, { id: '2', text: 'Report', status: 'pending' }] },
    } as KelpieEvent);

    sessions = manager(store, { FAKE_FIXTURE: resumed });
    const reloaded = sessions.get(session.id)!;
    const from = store.eventCount(session.id);
    reloaded.send('Carry on');
    const log = await until(reloaded, 'turn.ended', from);
    await sessions.stopAll();
    const last = log.slice(from).filter((e) => e.kind === 'todos').at(-1);
    expect(last?.kind === 'todos' && last.data.items.map((t) => `${t.id}:${t.status}`)).toEqual(['1:completed', '2:completed']);
    store.close();
  });

  it('closes out a run the daemon never saw finish', () => {
    const store = openStore(':memory:');
    store.createSession({ id: 's', cwd: tmpdir(), title: 'Crashed' }, 1000);
    const base = { runId: 'r1', ts: '2026-01-01T00:00:00.000Z', harness: 'claude-code' as const };
    const log = [
      { ...base, id: 'a', seq: 0, kind: 'activity', data: { busy: true } },
      { ...base, id: 'b', seq: 1, kind: 'tool.started', data: { callId: 'c1', name: 'Bash', category: 'bash', title: 'sleep 100', input: {} } },
    ] as KelpieEvent[];
    log.forEach((e, i) => store.appendEvent('s', i, e, 1000));

    const sessions = manager(store);
    const info = sessions.list()[0]!;
    expect(info).toMatchObject({ busy: false, lastTurn: 'interrupted', updatedAt: 1000 });
    const closing = store.loadEvents('s').slice(2);
    expect(closing.map((e) => [e.kind, e.seq, e.runId])).toEqual([
      ['turn.ended', 2, 'r1'],
      ['activity', 3, 'r1'],
      ['process.exited', 4, 'r1'],
    ]);
    expect(closing[1]!.data).toEqual({ busy: false });

    manager(store); // a second start finds nothing to repair
    expect(store.eventCount('s')).toBe(5);
  });

  it('starts a fresh harness session when the stored one cannot be resumed', async () => {
    const store = openStore(':memory:');
    store.createSession({ id: 's', cwd: tmpdir(), title: 'Old', harnessSessionId: 'gone' });
    const sessions = manager(store, { FAKE_RESUME_FAIL: '1' });
    const session = sessions.get('s')!;
    session.send('hello again');
    const log = await until(session, 'process.exited');
    expect(log.find((e) => e.kind === 'turn.ended')!.data).toMatchObject({ status: 'failed', error: 'No conversation found with session ID: gone' });
    expect(session.info().harnessSessionId).toBeUndefined();
    expect(store.getSession('s')!.harnessSessionId).toBeNull();
  });

  it('stops an idle harness process and resumes it on the next message', async () => {
    const argsFile = join(tmp('kelpie-args-'), 'args.jsonl');
    const sessions = manager(openStore(':memory:'), { FAKE_ARGS_FILE: argsFile }, { idleMs: 50 });
    const session = sessions.create();
    session.send('What is 2+2?');
    const log = await until(session, 'process.exited');
    expect(log.at(-1)!.data).toMatchObject({ code: 0 });

    session.send('again');
    await until(session, 'turn.ended', log.length);
    await sessions.stopAll();
    expect(argsOf(argsFile)[1]).toContain('--resume');
  });

  it('waits for an idle process that is shutting down, then resumes in a new one', async () => {
    const argsFile = join(tmp('kelpie-args-'), 'args.jsonl');
    const sessions = manager(openStore(':memory:'), { FAKE_ARGS_FILE: argsFile, FAKE_EXIT_DELAY: '400' }, { idleMs: 20 });
    const session = sessions.create();
    await session.send('What is 2+2?');
    const first = await until(session, 'turn.ended');
    await new Promise((r) => setTimeout(r, 150)); // idle stop has begun; the process lingers 400ms

    await session.send('again'); // must not throw "stopping"
    const log = await until(session, 'turn.ended', first.length + 1);
    await sessions.stopAll();
    expect(log.filter((e) => e.kind === 'process.exited')).toHaveLength(1); // the idle one, before the new run
    expect(argsOf(argsFile)[1]).toContain('--resume');
  });

  it('keeps a log in memory only while it is watched or written', async () => {
    const store = openStore(':memory:');
    const sessions = manager(store);
    const session = sessions.create();
    const loaded = () => (session as unknown as { log?: unknown[] }).log !== undefined;
    await session.send('What is 2+2?');
    await until(session, 'turn.ended');
    expect(loaded()).toBe(true); // the run is still alive
    await session.stop();
    expect(loaded()).toBe(false);
    const stop = session.subscribe(() => {});
    expect(loaded()).toBe(true);
    stop();
    expect(loaded()).toBe(false);
    expect((await until(session, 'process.exited')).length).toBe(store.eventCount(session.id)); // reloads from the store intact
  });

  it('keeps usage across restarts, and a failing usage write never stops the run', async () => {
    const store = openStore(':memory:');
    const sessions = manager(store);
    store.setUsage = () => {
      throw new Error('disk full');
    };
    const errors = console.error;
    console.error = () => {};
    try {
      const session = sessions.create();
      await session.send('What is 2+2?');
      const log = await until(session, 'turn.ended');
      expect(log.some((e) => e.kind === 'message' && e.data.role === 'assistant')).toBe(true); // the run went on
      expect(sessions.usage()[0]?.usage.windows?.seven_day).toBeDefined(); // and usage is still served
      await sessions.stopAll();
    } finally {
      console.error = errors;
    }

    const persisted = openStore(':memory:');
    persisted.setUsage('claude-code', { status: 'allowed', windows: { seven_day: { utilization: 0.5, resetsAt: '2026-01-01T00:00:00.000Z' } } }, 1000);
    expect(manager(persisted).usage()).toEqual([
      { harness: 'claude-code', usage: { status: 'allowed', windows: { seven_day: { utilization: 0.5, resetsAt: '2026-01-01T00:00:00.000Z' } } }, updatedAt: 1000 },
    ]);
  });

  it('titles a round-up from the first line of its first message', () => {
    expect(titleFrom('  Fix   the build\nmore detail')).toBe('Fix the build');
    expect(titleFrom('x'.repeat(80))).toHaveLength(60);
  });
});
