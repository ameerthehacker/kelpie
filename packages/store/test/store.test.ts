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

  it('keeps the latest usage report per harness', () => {
    const store = openStore(':memory:');
    const first = { status: 'allowed', windows: { five_hour: { utilization: 0.3, resetsAt: '2026-01-01T05:00:00.000Z' } } };
    store.setUsage('claude-code', first, 1000);
    store.setUsage('claude-code', { ...first, status: 'allowed_warning' }, 2000);
    expect(store.listUsage()).toEqual([{ harness: 'claude-code', usage: { ...first, status: 'allowed_warning' }, updatedAt: 2000 }]);
  });

  it('skips usage rows it cannot read rather than failing', () => {
    const store = openStore(':memory:');
    store.setUsage('claude-code', { status: 'allowed' }, 1000);
    const raw = (store as unknown as { sqlite: { prepare(sql: string): { run(...a: unknown[]): void } } }).sqlite;
    raw.prepare('insert into harness_usage values (?, ?, ?)').run('codex', '{not json', 1);
    raw.prepare('insert into harness_usage values (?, ?, ?)').run('mystery', '{"status":"allowed"}', 1);
    expect(store.listUsage().map((u) => u.harness)).toEqual(['claude-code']);
  });

  it('keeps one secret per connector, replacing it when connected again', () => {
    const store = openStore(':memory:');
    store.setConnection({ provider: 'github', method: 'token', secret: 'ghp_one', account: 'octo', scopes: ['repo'] }, 1000);
    store.setConnection({ provider: 'github', method: 'token', secret: 'ghp_two', account: 'octo', scopes: null }, 2000);
    expect(store.getConnection('github')).toEqual({ provider: 'github', method: 'token', secret: 'ghp_two', account: 'octo', scopes: null, createdAt: 1000, updatedAt: 2000 });
    expect(store.deleteConnection('github')).toBe(true);
    expect(store.getConnection('github')).toBeUndefined();
    expect(store.deleteConnection('github')).toBe(false);
  });
});
