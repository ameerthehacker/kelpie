import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import { openStore } from '../src/index.js';

const ev = (seq: number, kind: 'message' | 'activity', data: unknown) =>
  ({ id: `e${seq}`, runId: 'r1', seq, ts: '2026-01-01T00:00:00.000Z', harness: 'claude-code', kind, data }) as KelpieEvent;

describe('store', () => {
  it('migrates a fresh file and keeps data across reopen', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kelpie-store-')), 'nested', 'kelpie.db');
    const a = openStore(path);
    a.createSession({ id: 's1', cwd: '/work/repo', title: 'Hello' });
    a.close();
    const b = openStore(path);
    expect(b.getSession('s1')).toMatchObject({ id: 's1', cwd: '/work/repo', title: 'Hello', harness: 'claude-code', harnessSessionId: null });
    b.close();
  });

  it('lists the most recently active round-up first', () => {
    const store = openStore(':memory:');
    store.createSession({ id: 'old', cwd: '/r' }, 1000);
    store.createSession({ id: 'new', cwd: '/r' }, 2000);
    expect(store.listSessions().map((s) => s.id)).toEqual(['new', 'old']);
    store.appendEvent('old', 0, ev(1, 'message', { role: 'user', text: 'hi' }), 3000);
    expect(store.listSessions().map((s) => s.id)).toEqual(['old', 'new']);
  });

  it('round-trips events in log order and finds the last of a kind', () => {
    const store = openStore(':memory:');
    store.createSession({ id: 's', cwd: '/r' });
    const log = [ev(1, 'activity', { busy: true }), ev(2, 'message', { role: 'user', text: 'hi' }), ev(3, 'activity', { busy: false })];
    log.forEach((e, i) => store.appendEvent('s', i, e));
    expect(store.loadEvents('s')).toEqual(log);
    expect(store.lastEvent('s', 'activity')?.data).toEqual({ busy: false });
    expect(store.eventCount('s')).toBe(3);
    expect(() => store.appendEvent('s', 1, log[0]!)).toThrow(); // an index is written once
  });

  it('updates fields and deletes a round-up with its events', () => {
    const store = openStore(':memory:');
    store.createSession({ id: 's', cwd: '/r' });
    store.appendEvent('s', 0, ev(1, 'message', { role: 'user', text: 'hi' }));
    expect(store.updateSession('s', { title: 'Renamed', harnessSessionId: 'abc' })).toMatchObject({ title: 'Renamed', harnessSessionId: 'abc' });
    expect(store.deleteSession('s')).toBe(true);
    expect(store.getSession('s')).toBeUndefined();
    expect(store.eventCount('s')).toBe(0);
    expect(store.deleteSession('s')).toBe(false);
  });
});
