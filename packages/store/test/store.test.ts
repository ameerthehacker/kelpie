import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTicketUrl, type KelpieEvent, type TicketLink } from '@kelpie/protocol';
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

  it('saves settings as JSON, one row per key, replacing a value set again', () => {
    const store = openStore(':memory:');
    expect(store.settings()).toEqual({});
    store.setSettings({ maxAgents: 6 }, 1000);
    store.setSettings({ maxAgents: 8, other: { on: true } }, 2000);
    expect(store.settings()).toEqual({ maxAgents: 8, other: { on: true } });
  });

  it('adds the settings table on top of every earlier migration, keeping what was there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kelpie-store-'));
    const before = join(dir, 'drizzle');
    cpSync(join(import.meta.dirname, '../drizzle'), before, { recursive: true });
    const journal = join(before, 'meta/_journal.json');
    const j = JSON.parse(readFileSync(journal, 'utf8')) as { entries: { tag: string }[] };
    expect(j.entries.map((e) => e.tag)).toContain('0014_settings');
    j.entries = j.entries.filter((e) => e.tag < '0014');
    writeFileSync(journal, JSON.stringify(j));
    const path = join(dir, 'kelpie.db');
    const old = openStore(path, { migrationsFolder: before });
    old.createSession({ id: 'r', cwd: '/r' });
    expect(() => old.settings()).toThrow(/no such table/);
    old.close();
    const store = openStore(path);
    expect(store.getSession('r')).toBeDefined();
    expect(store.settings()).toEqual({});
    store.setSettings({ maxAgents: 3 });
    expect(store.settings()).toEqual({ maxAgents: 3 });
    store.close();
  });

  it('adds the tickets table to a store made before it, keeping its round-ups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kelpie-store-'));
    const before = join(dir, 'drizzle');
    cpSync(join(import.meta.dirname, '../drizzle'), before, { recursive: true });
    const journal = join(before, 'meta/_journal.json');
    const j = JSON.parse(readFileSync(journal, 'utf8')) as { entries: { tag: string }[] };
    j.entries = j.entries.filter((e) => e.tag < '0011');
    writeFileSync(journal, JSON.stringify(j));
    const path = join(dir, 'kelpie.db');
    const old = openStore(path, { migrationsFolder: before });
    old.createSession({ id: 'r', cwd: '/r' });
    old.close();
    const store = openStore(path);
    expect(store.getSession('r')).toBeDefined();
    expect(store.linkTicket('r', ticket('https://acme.atlassian.net/browse/PLAT-88'), 'auto')).toBe(true);
    expect(store.ticketsOf('r')).toHaveLength(1);
    store.close();
  });
});

const ticket = (url: string): TicketLink => parseTicketUrl(url)!;

describe('tickets', () => {
  it("links each ticket once, whatever form its link takes, and lists a round-up's in order", () => {
    const store = openStore(':memory:');
    store.createSession({ id: 'r', cwd: '/r' });
    store.createSession({ id: 'other', cwd: '/r' });
    expect(store.linkTicket('r', ticket('https://acme.atlassian.net/browse/SHOP-412'), 'auto', undefined, 1000)).toBe(true);
    expect(store.linkTicket('r', ticket('https://app.asana.com/0/1201/list'), 'orchestrator', 'Q4 checkout launch', 2000)).toBe(true);
    // The same issue from a board link: already linked.
    expect(store.linkTicket('r', ticket('https://acme.atlassian.net/jira/software/projects/SHOP/boards/3?selectedIssue=SHOP-412'), 'auto')).toBe(false);
    store.linkTicket('other', ticket('https://acme.atlassian.net/browse/SHOP-412'), 'auto');
    expect(store.ticketsOf('r')).toMatchObject([
      { provider: 'jira', kind: 'issue', key: 'SHOP-412', url: 'https://acme.atlassian.net/browse/SHOP-412', title: null, source: 'auto', createdAt: 1000 },
      { provider: 'asana', kind: 'project', key: null, url: 'https://app.asana.com/0/1201/list', title: 'Q4 checkout launch', source: 'orchestrator', createdAt: 2000 },
    ]);
  });

  it('titles a ticket linked again with a title, and only says so when it changed', () => {
    const store = openStore(':memory:');
    store.createSession({ id: 'r', cwd: '/r' });
    const t = ticket('https://app.asana.com/0/1201/1209');
    store.linkTicket('r', t, 'auto');
    expect(store.linkTicket('r', t, 'orchestrator', '  Guest checkout  ')).toBe(true);
    expect(store.linkTicket('r', t, 'orchestrator', 'Guest checkout')).toBe(false);
    expect(store.linkTicket('r', t, 'orchestrator', '')).toBe(false);
    expect(store.ticketsOf('r')).toMatchObject([{ title: 'Guest checkout', source: 'auto' }]);
  });

  it('unlinks a ticket, and drops them all with their round-up', () => {
    const store = openStore(':memory:');
    store.createSession({ id: 'r', cwd: '/r' });
    const a = ticket('https://acme.atlassian.net/browse/SHOP-412');
    store.linkTicket('r', a, 'auto');
    store.linkTicket('r', ticket('https://acme.atlassian.net/browse/SHOP-420'), 'auto');
    expect(store.unlinkTicket('r', a.ref)).toBe(true);
    expect(store.unlinkTicket('r', a.ref)).toBe(false);
    expect(store.ticketsOf('r').map((t) => t.key)).toEqual(['SHOP-420']);
    store.deleteSession('r');
    expect(store.ticketsOf('r')).toEqual([]);
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

describe('workbench', () => {
  const base = () => {
    const store = openStore(':memory:');
    store.createSession({ id: 'r', cwd: '/r' });
    store.createSession({ id: 'a', cwd: '/r', parentId: 'r', role: 'agent' });
    store.createSession({ id: 'b', cwd: '/r', parentId: 'r', role: 'agent' });
    return store;
  };

  it('adds the workbench tables to a store made before them, keeping its round-ups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kelpie-store-'));
    const before = join(dir, 'drizzle');
    cpSync(join(import.meta.dirname, '../drizzle'), before, { recursive: true });
    const journal = join(before, 'meta/_journal.json');
    const j = JSON.parse(readFileSync(journal, 'utf8')) as { entries: { tag: string }[] };
    expect(j.entries.map((e) => e.tag)).toContain('0016_workbench');
    j.entries = j.entries.filter((e) => e.tag < '0016');
    writeFileSync(journal, JSON.stringify(j));
    const path = join(dir, 'kelpie.db');
    const old = openStore(path, { migrationsFolder: before });
    old.createSession({ id: 'r', cwd: '/r' });
    expect(() => old.cards()).toThrow(/no such table/);
    old.close();
    const store = openStore(path);
    expect(store.getSession('r')).toBeDefined();
    expect(store.createCard({ roundUpId: 'r', title: 'Checkout', stage: 'building' }).title).toBe('Checkout');
    store.close();
  });

  it('creates and patches cards, keeping tickets as JSON and stamping done', () => {
    const store = base();
    const card = store.createCard({ roundUpId: 'r', title: 'Checkout', stage: 'building', tickets: [{ provider: 'jira', url: 'https://x.atlassian.net/browse/A-1' }] }, 1000);
    expect(card).toMatchObject({ roundUpId: 'r', stage: 'building', callout: null, doneAt: null, archivedAt: null, createdAt: 1000, updatedAt: 1000 });
    expect(card.tickets).toEqual([{ provider: 'jira', url: 'https://x.atlassian.net/browse/A-1' }]);
    expect(store.updateCard(card.id, { stage: 'review', callout: 'Look at #412' }, 2000)).toMatchObject({ stage: 'review', callout: 'Look at #412', title: 'Checkout', updatedAt: 2000 });
    expect(store.createCard({ roundUpId: 'r', title: 'Done already', stage: 'done' }, 3000).doneAt).toBe(3000);
    expect(store.cards('r').map((c) => c.title)).toEqual(['Checkout', 'Done already']);
    expect(store.updateCard('nope', { title: 'x' })).toBeUndefined();
  });

  it('upserts items by key, changing only the fields given', () => {
    const store = base();
    const card = store.createCard({ roundUpId: 'r', title: 'Checkout', stage: 'building' });
    expect(store.upsertItem(card.id, { key: 'a', agentId: 'a' }, 1000)).toMatchObject({ title: 'a', status: 'draft', agentId: 'a' });
    store.upsertItem(card.id, { key: 'a', title: 'Checkout API', ref: '#412' }, 2000);
    const item = store.upsertItem(card.id, { key: 'a', status: 'review', ref: null }, 3000);
    expect(item).toMatchObject({ title: 'Checkout API', ref: null, status: 'review', agentId: 'a', createdAt: 1000, updatedAt: 3000 });
    store.upsertItem(card.id, { key: 'docs', title: 'Docs' });
    expect(store.itemsOf([card.id]).map((i) => i.key)).toEqual(['a', 'docs']);
    expect(store.itemsOfAgent('a')).toHaveLength(1);
    expect(store.removeItem(card.id, 'docs')).toBe(true);
    expect(store.removeItem(card.id, 'docs')).toBe(false);
  });

  it("keeps one entry per agent, with its claims, and clears fields set to null", () => {
    const store = base();
    store.setEntry('a', 'r', { focus: 'Checkout API', claims: ['packages/api/**'], blocker: 'needs the schema' }, 1000);
    expect(store.setEntry('a', 'r', { blocker: null, progress: 'routes done' }, 2000)).toEqual({
      sessionId: 'a',
      roundUpId: 'r',
      focus: 'Checkout API',
      claims: ['packages/api/**'],
      blocker: null,
      progress: 'routes done',
      updatedAt: 2000,
    });
    store.setEntry('b', 'r', { claims: [] });
    expect(store.entriesOf(['r']).map((e) => e.sessionId).sort()).toEqual(['a', 'b']);
    expect(store.entriesOf([])).toEqual([]);
  });

  it('keeps notes, hands over the undelivered ones, and counts what a sender posted', () => {
    const store = base();
    const card = store.createCard({ roundUpId: 'r', title: 'Checkout', stage: 'building' });
    const note = (body: string, at: number, to?: string) =>
      store.addNote({ roundUpId: 'r', cardId: card.id, fromId: 'a', fromTitle: 'A', toId: to ?? null, toTitle: to ? to.toUpperCase() : null, body }, at);
    note('hello all', 1000);
    const n2 = note('b, your types?', 2000, 'b');
    note('and again', 3000, 'b');
    expect(store.notesOf('r').map((n) => n.body)).toEqual(['hello all', 'b, your types?', 'and again']);
    expect(store.notesOf('r', { limit: 2 }).map((n) => n.body)).toEqual(['b, your types?', 'and again']);
    expect(store.undeliveredNotes('b').map((n) => n.id)).toHaveLength(2);
    store.markNotesDelivered([n2.id], 4000);
    expect(store.undeliveredNotes('b').map((n) => n.body)).toEqual(['and again']);
    expect(store.notesFromSince('a', 2000)).toBe(2);
    expect(store.notesFromSince('a', 0, 'b')).toBe(2);
  });

  it('drops cards, items, entries and notes with their round-up; a deleted agent leaves its item and notes', () => {
    const store = base();
    const card = store.createCard({ roundUpId: 'r', title: 'Checkout', stage: 'building' });
    store.upsertItem(card.id, { key: 'a', agentId: 'a' });
    store.setEntry('a', 'r', { focus: 'x' });
    store.addNote({ roundUpId: 'r', cardId: card.id, fromId: 'a', fromTitle: 'A', toId: 'b', toTitle: 'B', body: 'hi' });
    store.deleteSession('a');
    expect(store.itemsOf([card.id])[0]).toMatchObject({ key: 'a', agentId: null });
    expect(store.notesOf('r')[0]).toMatchObject({ fromId: null, fromTitle: 'A' });
    expect(store.entriesOf(['r'])).toEqual([]);
    store.deleteSession('r');
    expect(store.cards()).toEqual([]);
    expect(store.itemsOf([card.id])).toEqual([]);
    expect(store.notesOf('r')).toEqual([]);
  });
});
