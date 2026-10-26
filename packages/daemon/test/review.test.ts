import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import type { ManagerUpdate, ReviewState, ReviewThread, Session, SessionManager } from '../src/index.js';
import { commit, git, jsonLines, LOCAL, lines, mcpClient, reported, roundUp, setup, sleep, startWith, waitFor, writer, type Ctx } from './review-fixtures.js';

const managers: SessionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stopAll()));
});
const start = (...args: Parameters<typeof setup>) => {
  const ctx = setup(...args);
  managers.push(ctx.sessions);
  return ctx;
};

/** API changed line 2 of app.txt; Docs line 18 and base.txt. Both mustered. */
async function mustered(ctx: Ctx) {
  const parent = await roundUp(ctx);
  const api = await writer(ctx, parent, 'API');
  const docs = await writer(ctx, parent, 'Docs');
  commit(api.cwd, 'app.txt', lines({ 2: 'L2 api' }));
  commit(docs.cwd, 'app.txt', lines({ 18: 'L18 docs' }));
  writeFileSync(join(docs.cwd, 'base.txt'), 'keep\nend\n');
  commit(docs.cwd, 'docs.txt', 'docs\n');
  await ctx.orch.muster(parent, [api.id, docs.id]);
  const head = ctx.store.worktreeOf(parent.id)!;
  return { parent, api, docs, head: () => git(head.repoRoot, 'rev-parse', head.branch) };
}

type Anchor = { path: string; side: 'additions' | 'deletions'; line: number; lineText: string; view?: 'feature' | 'agent'; viewSessionId?: string };
const comment = (ctx: Ctx, parent: Session, commitSha: string, a: Anchor, body = 'please fix') =>
  ctx.api('POST', `/api/sessions/${parent.id}/review/comments`, { anchor: { view: 'feature', commitSha, ...a }, body });

const kelpieTurns = (s: Session) => s.events().filter((e): e is Extract<KelpieEvent, { kind: 'message' }> => e.kind === 'message' && e.data.source === 'kelpie');

describe('reviews', () => {
  it('starts threads in a draft, refuses a stale line, and puts each thread down to its agent', async () => {
    const ctx = start();
    const { parent, api, docs, head } = await mustered(ctx);
    const stale = await comment(ctx, parent, head(), { path: 'app.txt', side: 'additions', line: 2, lineText: 'l2' });
    expect(stale).toEqual({ status: 409, body: { error: expect.stringMatching(/moved on/), stale: true } });

    const a = await comment(ctx, parent, head(), { path: 'app.txt', side: 'additions', line: 2, lineText: 'L2 api' });
    expect(a.status).toBe(201);
    const thread = a.body.thread as ReviewThread;
    expect(thread).toMatchObject({
      view: 'feature',
      agent: { id: api.id, title: 'API' },
      path: 'app.txt',
      side: 'additions',
      line: 2,
      currentLine: 2,
      outdated: false,
      status: 'pending',
      comments: [{ author: 'person', body: 'please fix', state: 'pending' }],
    });
    expect(thread.diffHunk).toMatch(/^@@ -1,5 \+1,5 @@\n l1\n-l2\n\+L2 api$/);
    expect(a.body.review).toMatchObject({ state: 'pending', commentIds: [thread.comments[0]!.id] });
    const b = await comment(ctx, parent, head(), { path: 'base.txt', side: 'deletions', line: 2, lineText: 'drop' });
    expect(b.body.thread.agent).toMatchObject({ id: docs.id });
    // A reply goes into the same draft.
    const reply = await ctx.api('POST', `/api/sessions/${parent.id}/review/comments`, { threadId: thread.id, body: 'and test it' });
    expect(reply.body.review.commentIds).toHaveLength(3);
    const state = (await ctx.api('GET', `/api/sessions/${parent.id}/review`)).body as ReviewState;
    expect(state.counts).toEqual({ open: 0, resolved: 0, pending: 2 });
    expect(state.pending!.commentIds).toHaveLength(3);
    expect(state.threads.map((t) => t.comments.length)).toEqual([2, 1]);
  });

  it('submits one notification to the orchestrator, grouped by agent, and keeps drafts away from MCP', async () => {
    const ctx = start();
    const { parent, api, head } = await mustered(ctx);
    const orchestrator = await mcpClient(ctx, await startWith(ctx, "You are Kelpie's orchestrator"));
    expect(await orchestrator.tools()).toEqual(['assign_threads', 'interrupt_agent', 'list_agents', 'list_branches', 'list_review_threads', 'message_agent', 'muster_agents', 'read_agent', 'read_review', 'reply_to_thread', 'resolve_thread', 'set_base_branch', 'spawn_agent']);
    const t1 = (await comment(ctx, parent, head(), { path: 'app.txt', side: 'additions', line: 2, lineText: 'L2 api' }, 'rename this')).body.thread as ReviewThread;
    const t2 = (await comment(ctx, parent, head(), { path: 'app.txt', side: 'additions', line: 5, lineText: 'l5' }, 'why is this here?')).body.thread as ReviewThread;
    expect((await orchestrator.call('list_review_threads', { status: 'all' })).data).toEqual([]);
    expect((await orchestrator.call('read_review')).data).toEqual({ review: null, threads: [], open: [] });

    const before = kelpieTurns(parent).length;
    const submitted = await ctx.api('POST', `/api/sessions/${parent.id}/review/submit`, { verdict: 'request_changes', body: 'Close, but not yet.' });
    expect(submitted.status).toBe(200);
    expect(submitted.body.review).toMatchObject({ state: 'submitted', verdict: 'request_changes', body: 'Close, but not yet.' });
    const turn = await waitFor(() => kelpieTurns(parent).length > before && kelpieTurns(parent).at(-1));
    expect(turn.data.review).toEqual({ reviewId: submitted.body.review.id, verdict: 'request_changes', comments: 2, threads: 2 });
    expect(turn.data.text).toBe(
      [
        '<kelpie-notification>',
        "The person submitted a review of the feature's changes: Request changes.",
        '> Close, but not yet.',
        `## Agent "API" (${api.id}): 1 thread`,
        `- [${t1.id}] app.txt:2 (additions): "rename this"`,
        '## No agent (base code, Muster, or a deleted/read-only agent): 1 thread',
        `- [${t2.id}] app.txt:5 (additions): "why is this here?"`,
        'Act on it now (see your rules). This message is from Kelpie, not the person.',
        '</kelpie-notification>',
      ].join('\n'),
    );
    await sleep(300);
    expect(kelpieTurns(parent).filter((e) => e.data.review)).toHaveLength(1);
    expect(ctx.store.undelivered(parent.id)).toEqual([]);

    const listed = (await orchestrator.call('list_review_threads')).data;
    expect(listed.map((t: { threadId: string; status: string }) => [t.threadId, t.status])).toEqual([
      [t1.id, 'open'],
      [t2.id, 'open'],
    ]);
    expect(listed[0]).toMatchObject({ currentLine: 2, outdated: false, lineText: 'L2 api', agent: { id: api.id, title: 'API' }, comments: [{ author: 'person', body: 'rename this' }] });
    // The orchestrator answers a question itself.
    expect((await orchestrator.call('resolve_thread', { threadId: t2.id, body: 'It is the base config.' })).data).toEqual({ threadId: t2.id, status: 'resolved' });
    const read = (await orchestrator.call('read_review')).data;
    expect(read.review).toMatchObject({ reviewId: submitted.body.review.id, verdict: 'request_changes' });
    expect(read.threads.map((t: { threadId: string }) => t.threadId)).toEqual([t1.id, t2.id]);
    expect(read.open.map((t: { threadId: string }) => t.threadId)).toEqual([t1.id]);
    const state = (await ctx.api('GET', `/api/sessions/${parent.id}/review`)).body as ReviewState;
    expect(state.threads.find((t) => t.id === t2.id)).toMatchObject({ status: 'resolved', resolvedBy: parent.id, comments: [{ author: 'person' }, { author: 'orchestrator', body: 'It is the base config.' }] });
    expect(state.reviews).toHaveLength(1);
    expect(state.pending).toBeNull();
    await orchestrator.close();
  });

  it("marks a thread outdated once its line is changed and re-mustered, and follows a line that moved", async () => {
    const ctx = start();
    const { parent, api, docs, head } = await mustered(ctx);
    const edited = (await comment(ctx, parent, head(), { path: 'app.txt', side: 'additions', line: 2, lineText: 'L2 api' })).body.thread as ReviewThread;
    const moved = (await comment(ctx, parent, head(), { path: 'app.txt', side: 'additions', line: 18, lineText: 'L18 docs' })).body.thread as ReviewThread;
    await ctx.orch.reviews.submit(parent.id, 'request_changes');
    const since = ctx.store.getSession(api.id)!.notifiedIdx;
    await ctx.orch.assignThreads(parent, { threadIds: [edited.id], agentId: api.id });
    await reported(ctx, api, since);
    // API's fix: a new first line, and line 2 rewritten.
    commit(api.cwd, 'app.txt', lines({ 2: 'L2 api, renamed', 18: 'L18 docs' }, { before: ['// header'] }));
    expect((await ctx.orch.muster(parent, [api.id])).merged).toEqual(['API']);
    const state = await ctx.orch.reviews.state(parent.id);
    const now = (id: string) => state.threads.find((t) => t.id === id)!;
    expect(now(edited.id)).toMatchObject({ outdated: true, line: 2 });
    expect(now(edited.id).currentLine).toBeUndefined();
    expect(now(moved.id)).toMatchObject({ outdated: false, line: 18, currentLine: 19 });
    expect(docs.id).toBeTruthy();
  });

  it('sends the review again when a muster moves the lines its threads are on', async () => {
    const ctx = start();
    const { parent, api, head } = await mustered(ctx);
    const moved = (await comment(ctx, parent, head(), { path: 'app.txt', side: 'additions', line: 18, lineText: 'L18 docs' })).body.thread as ReviewThread;
    await ctx.orch.reviews.submit(parent.id, 'request_changes');
    const since = ctx.store.getSession(api.id)!.notifiedIdx;
    await ctx.orch.message(parent, api.id, 'add a header');
    await reported(ctx, api, since);
    await sleep(300);
    const seen: ManagerUpdate[] = [];
    ctx.sessions.watch((u) => u.type === 'review' && seen.push(u));
    // Nothing in the review changes, only the feature branch under it: the thread's line moves down one.
    commit(api.cwd, 'app.txt', lines({ 2: 'L2 api', 18: 'L18 docs' }, { before: ['// header'] }));
    expect((await ctx.orch.muster(parent, [api.id])).merged).toEqual(['API']);
    const update = await waitFor(() => seen.find((u) => u.type === 'review'), 3000);
    const thread = update.type === 'review' ? update.state.threads.find((t) => t.id === moved.id) : undefined;
    expect(thread).toMatchObject({ outdated: false, line: 18, currentLine: 19 });
  });

  it('never sends a review state older than one already sent', async () => {
    const ctx = start();
    const parent = ctx.sessions.create();
    const seen: ManagerUpdate[] = [];
    ctx.sessions.watch((u) => u.type === 'review' && seen.push(u));
    const builds: ((s: ReviewState) => void)[] = [];
    ctx.orch.reviews.state = () => new Promise((resolve) => builds.push(resolve));
    const state = (open: number): ReviewState => ({ roundUpId: parent.id, pending: null, reviews: [], threads: [], counts: { open, resolved: 0, pending: 0 } });
    ctx.orch.reviews.changed(parent.id);
    await waitFor(() => builds.length === 1);
    ctx.orch.reviews.changed(parent.id);
    await waitFor(() => builds.length === 2);
    // The second build finishes first; the first, slower one is stale by the time it is done.
    builds[1]!(state(2));
    builds[0]!(state(1));
    await sleep(50);
    expect(seen.map((u) => u.type === 'review' && u.state.counts.open)).toEqual([2]);
  });

  it("checks a comment on one of an agent's rounds against that round, and finds its thread there", async () => {
    const ctx = start();
    const { parent, api } = await mustered(ctx);
    const since = ctx.store.getSession(api.id)!.notifiedIdx;
    await ctx.orch.message(parent, api.id, 'one more thing');
    await reported(ctx, api, since);
    // Round 2, under way: line 2 is rewritten (committed), and line 3 uncommitted.
    commit(api.cwd, 'app.txt', lines({ 2: 'L2 api v2', 18: 'L18 docs' }));
    writeFileSync(join(api.cwd, 'app.txt'), lines({ 2: 'L2 api v2', 3: 'L3 wip', 18: 'L18 docs' }));
    const changes = (await ctx.orch.changes.of(api.id))!;
    expect(changes.rounds!.map((r) => [r.index, r.state])).toEqual([
      [1, 'mustered'],
      [2, 'active'],
    ]);
    const [one, two] = changes.rounds!;
    const on = (commitSha: string, line: number, lineText: string) =>
      ctx.api('POST', `/api/sessions/${parent.id}/review/comments`, { anchor: { view: 'agent', viewSessionId: api.id, path: 'app.txt', side: 'additions', line, commitSha, lineText }, body: 'hm' });

    // Made on round 1 (its head names it): checked there, though round 2 changed the line since.
    const old = await on(one!.headSha, 2, 'L2 api');
    expect(old.status).toBe(201);
    expect(old.body.thread).toMatchObject({ view: 'agent', viewSessionId: api.id, agent: { id: api.id }, currentLine: 2, outdated: false, commitSha: one!.headSha });
    expect(old.body.thread.diffHunk).toContain('+L2 api');
    expect(ctx.store.thread(old.body.thread.id)!.baseSha).toBe(one!.baseSha);
    // On round 2, dirty: its HEAD names it, and the worktree's lines count.
    const now = await on(two!.headSha, 3, 'L3 wip');
    expect(now.status).toBe(201);
    expect(ctx.store.thread(now.body.thread.id)!.baseSha).toBe(two!.baseSha);
    // A commit that names no round falls back to the default one, where line 2 no longer says that.
    expect((await on('deadbeef', 2, 'L2 api')).status).toBe(409);
    expect((await on('deadbeef', 2, 'L2 api v2')).status).toBe(201);

    // Round 2 goes on (a new HEAD, then mustered): its thread is still found in its round, and round 1's in round 1.
    commit(api.cwd, 'app.txt', lines({ 1: 'L1 top', 2: 'L2 api v2', 3: 'L3 wip', 18: 'L18 docs' }));
    expect((await ctx.orch.muster(parent, [api.id])).merged).toEqual(['API']);
    const state = await ctx.orch.reviews.state(parent.id);
    const thread = (id: string) => state.threads.find((t) => t.id === id)!;
    expect(thread(old.body.thread.id)).toMatchObject({ currentLine: 2, outdated: false });
    expect(thread(now.body.thread.id)).toMatchObject({ currentLine: 3, outdated: false });
  });

  it('streams review and changes events', async () => {
    const ctx = start();
    const seen: ManagerUpdate[] = [];
    ctx.sessions.watch((u) => (u.type === 'review' || u.type === 'changes') && seen.push(u));
    const res = await ctx.app.request('/api/events', { headers: { host: LOCAL.host } });
    const reader = res.body!.getReader();
    let text = '';
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += new TextDecoder().decode(value);
      }
    })();
    const { parent, api, head } = await mustered(ctx);
    // An agent going idle, and a muster.
    expect(seen).toContainEqual({ type: 'changes', roundUpId: parent.id, sessionId: api.id });
    expect(seen).toContainEqual({ type: 'changes', roundUpId: parent.id, sessionId: parent.id });
    await comment(ctx, parent, head(), { path: 'app.txt', side: 'additions', line: 2, lineText: 'L2 api' });
    const update = await waitFor(() => seen.find((u) => u.type === 'review'));
    expect(update.type === 'review' && update.state.counts).toEqual({ open: 0, resolved: 0, pending: 1 });
    await waitFor(() => text.includes('event: review') && text.includes('event: changes'));
    expect(text).toContain(`"sessionId":"${api.id}"`);
    await reader.cancel();
    await pump.catch(() => {});
  });

  it('gives an agent only its assigned threads over MCP, and starts a writer for the rest', async () => {
    const ctx = start();
    const { parent, api, docs, head } = await mustered(ctx);
    const orchestrator = await mcpClient(ctx, await startWith(ctx, "You are Kelpie's orchestrator"));
    const mine = (await comment(ctx, parent, head(), { path: 'app.txt', side: 'additions', line: 2, lineText: 'L2 api' }, 'rename it')).body.thread as ReviewThread;
    const theirs = (await comment(ctx, parent, head(), { path: 'base.txt', side: 'deletions', line: 2, lineText: 'drop' }, 'keep this line')).body.thread as ReviewThread;
    const base = (await comment(ctx, parent, head(), { path: 'app.txt', side: 'additions', line: 5, lineText: 'l5' }, 'and this')).body.thread as ReviewThread;
    expect((await orchestrator.call('assign_threads', { threadIds: [mine.id], agentId: api.id })).error).toMatch(/pending, not open/);
    await ctx.orch.reviews.submit(parent.id, 'comment');

    const since = ctx.store.getSession(api.id)!.notifiedIdx;
    const given = await orchestrator.call('assign_threads', { threadIds: [mine.id], agentId: api.id, notes: 'Keep the old name as an alias.' });
    expect(given.data).toEqual({ agentId: api.id, status: 'working', threads: 1 });
    expect(ctx.store.thread(mine.id)!.assignedTo).toBe(api.id);
    const { text } = await waitFor(() => jsonLines<{ text: string }>(ctx.stdinFile).find((l) => l.text.startsWith('The person reviewed changes')));
    expect(text).toContain('The person reviewed changes and left these threads on code you changed.');
    expect(text).toContain(`Thread: ${mine.id}`);
    expect(text).toContain('```diff\n@@ -1,5 +1,5 @@');
    expect(text).toContain('- person: rename it');
    expect(text).toContain('Notes from the orchestrator: Keep the old name as an alias.');
    await reported(ctx, api, since);
    // Mustered before, so it was started afresh in a recreated worktree, with a token of its own.
    expect(ctx.store.worktreeOf(api.id)!.state).toBe('active');
    const agent = await mcpClient(ctx, await startWith(ctx, ctx.store.worktreeOf(api.id)!.branch));
    expect(await agent.tools()).toEqual(['list_review_threads', 'reply_to_thread', 'resolve_thread']);
    const listed = (await agent.call('list_review_threads')).data;
    expect(listed.map((t: { threadId: string }) => t.threadId)).toEqual([mine.id]);
    expect(listed[0]).toMatchObject({ path: 'app.txt', line: 2, currentLine: 2, outdated: false, comments: [{ author: 'person', body: 'rename it' }] });
    expect(listed[0].agent).toBeUndefined();
    expect((await agent.call('reply_to_thread', { threadId: theirs.id, body: 'mine now' })).error).toMatch(/assigned to you/);
    expect((await agent.call('resolve_thread', { threadId: theirs.id })).error).toMatch(/assigned to you/);
    expect((await agent.call('reply_to_thread', { threadId: mine.id, body: 'Renamed it, kept an alias.' })).data).toEqual({ threadId: mine.id, status: 'open' });
    expect((await agent.call('resolve_thread', { threadId: mine.id })).data).toEqual({ threadId: mine.id, status: 'resolved' });
    expect((await agent.call('list_review_threads')).data).toEqual([]);
    expect((await agent.call('list_review_threads', { status: 'resolved' })).data[0].comments.map((c: { author: string }) => c.author)).toEqual(['person', 'API']);
    expect(ctx.store.thread(mine.id)).toMatchObject({ status: 'resolved', resolvedBy: api.id });
    // Its next idle notification counts its threads.
    const before = kelpieTurns(parent).length;
    await ctx.orch.message(parent, api.id, 'anything else?');
    const note = await waitFor(() => kelpieTurns(parent).slice(before).find((e) => e.data.text.includes('Review threads:')));
    expect(note.data.text).toContain('Review threads: 1 resolved, 0 open');
    expect(note.data.agents?.find((a) => a.agentId === api.id)?.reviewThreads).toEqual({ open: 0, resolved: 1 });

    // Threads on base code (and Docs', for the test) go to a new writer.
    const fresh = await orchestrator.call('assign_threads', { threadIds: [base.id, theirs.id] });
    expect(fresh.data).toMatchObject({ status: 'working', threads: 2 });
    const fixer = ctx.sessions.get(fresh.data.agentId)!;
    expect(fixer).toMatchObject({ title: 'Review fixes', writes: true, kind: 'worker', parentId: parent.id });
    expect(ctx.store.worktreeOf(fixer.id)).toMatchObject({ deliver: 'muster', parentBranch: ctx.store.worktreeOf(parent.id)!.branch });
    expect(ctx.store.firstSent(fixer.id)!.text).toContain("left these threads on the feature's code");
    expect([ctx.store.thread(base.id)!.assignedTo, ctx.store.thread(theirs.id)!.assignedTo]).toEqual([fixer.id, fixer.id]);
    expect((await orchestrator.call('assign_threads', { threadIds: [mine.id], agentId: docs.id })).error).toMatch(/resolved, not open/);
    const { agentId: reader } = await ctx.orch.spawn(parent, { title: 'Look', task: 'x', writes: false });
    expect((await orchestrator.call('assign_threads', { threadIds: [base.id], agentId: reader })).error).toMatch(/read-only/);
    await agent.close();
    await orchestrator.close();

    // Plan mode: writers wait. (The orchestrator restarts into it, with a new token.)
    const open = (await comment(ctx, parent, head(), { path: 'app.txt', side: 'additions', line: 6, lineText: 'l6' }, 'one more')).body.thread as ReviewThread;
    await ctx.orch.reviews.submit(parent.id, 'request_changes');
    await ctx.sessions.setMode(parent, 'plan');
    const starts = jsonLines<string[]>(ctx.argsFile).length;
    await parent.send('Plan the rest');
    const planning = await mcpClient(ctx, await waitFor(() => jsonLines<string[]>(ctx.argsFile).slice(starts).find((a) => a.join(' ').includes("You are Kelpie's orchestrator"))));
    expect((await planning.call('assign_threads', { threadIds: [open.id], agentId: docs.id })).error).toMatch(/plan mode/);
    expect((await planning.call('assign_threads', { threadIds: [open.id] })).error).toMatch(/plan mode/);
    expect(ctx.store.thread(open.id)!.assignedTo).toBeNull();
    expect(ctx.sessions.children(parent.id).filter((c) => c.title === 'Review fixes')).toHaveLength(1);
    await planning.close();
  });
});
