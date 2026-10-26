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
});

describe('reviews', () => {
  const anchor = (roundUpId: string, extra: Record<string, unknown> = {}) => ({
    roundUpId,
    view: 'feature' as const,
    viewSessionId: null,
    agentId: null,
    agentTitle: null,
    path: 'app.ts',
    side: 'additions' as const,
    line: 3,
    commitSha: 'head',
    baseSha: 'base',
    lineText: 'x',
    diffHunk: '@@ -1 +1 @@',
    ...extra,
  });
  const person = (threadId: string, roundUpId: string, reviewId: string, body = 'fix this') => ({
    threadId,
    roundUpId,
    reviewId,
    author: 'person' as const,
    authorSessionId: null,
    authorTitle: null,
    body,
    state: 'pending' as const,
  });
  const roundUp = () => {
    const store = openStore(':memory:');
    store.createSession({ id: 'r', cwd: '/r' });
    store.createSession({ id: 'a', cwd: '/r', parentId: 'r', role: 'agent', writes: true, title: 'API' });
    return store;
  };

  it('keeps one pending review per round-up', () => {
    const store = roundUp();
    const first = store.ensurePendingReview('r');
    expect(store.ensurePendingReview('r').id).toBe(first.id);
    const raw = (store as unknown as { sqlite: { prepare(sql: string): { run(...a: unknown[]): void } } }).sqlite;
    expect(() => raw.prepare("insert into reviews (id, round_up_id, state, body, created_at) values ('x', 'r', 'pending', '', 1)").run()).toThrow(/UNIQUE/);
    store.submitReview(first.id, 'comment', 'ok', []);
    expect(store.pendingReview('r')).toBeUndefined();
    expect(store.ensurePendingReview('r').id).not.toBe(first.id);
  });

  it('publishes only the listed comments on submit and moves stray drafts to a fresh review', () => {
    const store = roundUp();
    const review = store.ensurePendingReview('r');
    const t1 = store.addThread(anchor('r'));
    const t2 = store.addThread(anchor('r', { line: 9 }));
    const c1 = store.addComment(person(t1.id, 'r', review.id));
    const c2 = store.addComment(person(t2.id, 'r', review.id, 'added while submitting'));
    store.setThreadStatus(t1.id, 'resolved', 'person');
    const done = store.submitReview(review.id, 'request_changes', 'please', [c1.id]);
    expect(done).toMatchObject({ state: 'submitted', verdict: 'request_changes', body: 'please' });
    expect(store.comment(c1.id)).toMatchObject({ state: 'published', reviewId: review.id });
    expect(store.thread(t1.id)).toMatchObject({ status: 'open', resolvedBy: null });
    const fresh = store.pendingReview('r')!;
    expect(fresh.id).not.toBe(review.id);
    expect(store.comment(c2.id)).toMatchObject({ state: 'pending', reviewId: fresh.id });
    expect(store.thread(t2.id)!.status).toBe('pending');
    expect(() => store.submitReview(review.id, 'approve', '', [])).toThrow(/not a draft/);
  });

  it('drops a thread with its only comment, and a whole draft on discard', () => {
    const store = roundUp();
    const review = store.ensurePendingReview('r');
    const t = store.addThread(anchor('r'));
    const c = store.addComment(person(t.id, 'r', review.id));
    expect(store.deleteComment(c.id)).toBe(true);
    expect(store.thread(t.id)).toBeUndefined();
    const t2 = store.addThread(anchor('r'));
    store.addComment(person(t2.id, 'r', review.id));
    expect(store.discardPending('r')).toBe(true);
    expect(store.threadsOf('r')).toEqual([]);
    expect(store.pendingReview('r')).toBeUndefined();
  });

  it('filters threads and assigns them', () => {
    const store = roundUp();
    const [t1, t2] = [store.addThread(anchor('r'), 1), store.addThread(anchor('r', { status: 'open' }), 2)];
    store.assignThreads([t2.id], 'a');
    expect(store.threadsOf('r', { status: ['open'] }).map((t) => t.id)).toEqual([t2.id]);
    expect(store.threadsOf('r', { assignedTo: 'a' }).map((t) => t.id)).toEqual([t2.id]);
    expect(store.threadsOf('r').map((t) => t.id)).toEqual([t1.id, t2.id]);
    expect(store.threadsOf('r', { ids: [] })).toEqual([]);
    expect(store.setThreadStatus(t2.id, 'resolved', 'a', 5)).toMatchObject({ status: 'resolved', resolvedBy: 'a', resolvedAt: 5 });
  });

  it('cascades with the round-up and sets an agent that goes to null', () => {
    const store = roundUp();
    const review = store.ensurePendingReview('r');
    const t = store.addThread(anchor('r', { agentId: 'a', agentTitle: 'API', status: 'open' }));
    store.assignThreads([t.id], 'a');
    store.addComment({ ...person(t.id, 'r', review.id), author: 'agent', authorSessionId: 'a', authorTitle: 'API', reviewId: null, state: 'published' });
    store.addDelivery({ roundUpId: 'r', sessionId: 'a', title: 'API', harness: 'claude-code', branch: 'b', forkCommit: 'f', tipCommit: 't' });
    store.deleteSession('a');
    expect(store.thread(t.id)).toMatchObject({ agentId: null, assignedTo: null, agentTitle: 'API' });
    expect(store.commentsOf([t.id])[0]).toMatchObject({ authorSessionId: null, authorTitle: 'API' });
    expect(store.deliveriesOf('r')[0]).toMatchObject({ sessionId: null, title: 'API' });
    store.deleteSession('r');
    expect(store.thread(t.id)).toBeUndefined();
    expect(store.review(review.id)).toBeUndefined();
    expect(store.deliveriesOf('r')).toEqual([]);
  });

  it('records a delivery once', () => {
    const store = roundUp();
    const d = { roundUpId: 'r', sessionId: 'a', title: 'API', harness: 'claude-code', branch: 'b', forkCommit: 'f', tipCommit: 't' };
    store.addDelivery(d);
    store.addDelivery(d);
    store.addDelivery({ ...d, tipCommit: 't2' });
    expect(store.deliveriesOf('r').map((x) => x.tipCommit)).toEqual(['t', 't2']);
  });
});
