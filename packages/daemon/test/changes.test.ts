import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionManager } from '../src/index.js';
import { commit, git, lines, reported, roundUp, setup, waitFor, writer, type Ctx } from './review-fixtures.js';

const managers: SessionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stopAll()));
});
const start = (...args: Parameters<typeof setup>) => {
  const ctx = setup(...args);
  managers.push(ctx.sessions);
  return ctx;
};

const brief = (files: { path: string; status: string; additions: number; deletions: number; agents: { title: string }[] }[]) =>
  files.map((f) => [f.path, f.status, f.additions, f.deletions, f.agents.map((a) => a.title).join(',')]);

/** Two writers mustered into the feature branch: API changes line 2 and adds api.txt; Docs changes line 18, drops a line of base.txt and adds docs.txt. */
async function twoMustered(ctx: Ctx) {
  const parent = await roundUp(ctx);
  const api = await writer(ctx, parent, 'API');
  const docs = await writer(ctx, parent, 'Docs');
  commit(api.cwd, 'app.txt', lines({ 2: 'L2 api' }));
  commit(api.cwd, 'api.txt', 'api\n');
  commit(docs.cwd, 'app.txt', lines({ 18: 'L18 docs' }));
  writeFileSync(join(docs.cwd, 'base.txt'), 'keep\nend\n');
  commit(docs.cwd, 'docs.txt', 'docs\n');
  const { merged } = await ctx.orch.muster(parent, [api.id, docs.id]);
  expect(merged).toEqual(['API', 'Docs']);
  return { parent, api, docs };
}

describe('changes', () => {
  it("shows the feature's diff after two agents are mustered, with who changed each file", async () => {
    const ctx = start();
    const { parent, api, docs } = await twoMustered(ctx);
    const home = ctx.store.worktreeOf(parent.id)!;
    const changes = (await ctx.orch.changes.of(parent.id))!;
    expect(changes).toMatchObject({
      scope: 'feature',
      state: 'ready',
      roundUpId: parent.id,
      branch: home.branch,
      baseRef: 'origin/main',
      baseSha: home.baseCommit,
      headSha: git(home.path, 'rev-parse', 'HEAD'),
      checkoutPath: home.path,
      stats: { files: 4, additions: 4, deletions: 3 },
    });
    expect(brief(changes.files)).toEqual([
      ['api.txt', 'added', 1, 0, 'API'],
      ['app.txt', 'modified', 2, 2, 'API,Docs'],
      ['base.txt', 'modified', 0, 1, 'Docs'],
      ['docs.txt', 'added', 1, 0, 'Docs'],
    ]);
    expect(changes.musteredFrom).toEqual([
      { id: api.id, title: 'API', harness: 'claude-code' },
      { id: docs.id, title: 'Docs', harness: 'claude-code' },
    ]);
    const app = changes.files.find((f) => f.path === 'app.txt')!;
    expect(app.patch).toMatch(/^diff --git a\/app.txt b\/app.txt\n/);
    expect(app.patch).toContain('+L2 api');
    // Deliveries were recorded before the branches went.
    expect(ctx.store.deliveriesOf(parent.id).map((d) => [d.title, d.branch])).toEqual([
      ['API', ctx.store.worktreeOf(api.id)!.branch],
      ['Docs', ctx.store.worktreeOf(docs.id)!.branch],
    ]);
    expect(git(ctx.checkout, 'branch', '--list', ctx.store.worktreeOf(api.id)!.branch)).toBe('');
    // A badge needs no patches.
    const bare = (await ctx.orch.changes.of(parent.id, { patches: false }))!;
    expect(bare.files.every((f) => f.patch === undefined)).toBe(true);
    expect(bare.stats.files).toBe(4);
  });

  it("puts a line down to its agent: blamed additions, a single agent's deletion, nobody for shared deletions and Muster's resolution", async () => {
    const ctx = start();
    const parent = await roundUp(ctx);
    const [api, docs, copy] = [await writer(ctx, parent, 'API'), await writer(ctx, parent, 'Docs'), await writer(ctx, parent, 'Copy')];
    commit(api.cwd, 'app.txt', lines({ 2: 'L2 api' }));
    commit(docs.cwd, 'app.txt', lines({ 18: 'L18 docs' }));
    writeFileSync(join(docs.cwd, 'base.txt'), 'keep\nend\n');
    commit(docs.cwd, 'docs.txt', 'docs\n');
    // Copy changes line 2 too: Muster gets it, and resolves the conflict with a line of its own.
    commit(copy.cwd, 'app.txt', lines({ 2: 'L2 copy' }));
    const { merged, muster } = await ctx.orch.muster(parent, [api.id, docs.id, copy.id]);
    expect(merged).toEqual(['API', 'Docs']);
    expect(muster?.conflicts).toEqual(['app.txt']);

    const owner = async (path: string, side: 'additions' | 'deletions', line: number, lineText: string) => {
      const r = await ctx.orch.changes.anchor(parent.id, { path, side, line, lineText });
      if (!r.ok) throw new Error(r.reason);
      return r.owner?.title ?? null;
    };
    expect(await owner('app.txt', 'additions', 2, 'L2 api')).toBe('API');
    expect(await owner('app.txt', 'additions', 18, 'L18 docs')).toBe('Docs');
    expect(await owner('app.txt', 'additions', 5, 'l5')).toBeNull(); // base code, as context
    expect(await owner('base.txt', 'deletions', 2, 'drop')).toBe('Docs');
    expect(await owner('app.txt', 'deletions', 2, 'l2')).toBeNull(); // two agents changed app.txt
    expect(await ctx.orch.changes.anchor(parent.id, { path: 'app.txt', side: 'additions', line: 2, lineText: 'l2' })).toEqual({ ok: false, reason: 'stale' });
    expect(await ctx.orch.changes.anchor(parent.id, { path: 'nope.txt', side: 'additions', line: 1, lineText: 'x' })).toEqual({ ok: false, reason: 'file' });

    const home = ctx.store.worktreeOf(parent.id)!;
    const agent = ctx.sessions.get(muster!.agentId)!;
    await reported(ctx, agent, -1);
    try {
      git(home.path, 'merge', '--no-ff', ctx.store.worktreeOf(copy.id)!.branch);
    } catch {}
    writeFileSync(join(home.path, 'app.txt'), lines({ 2: 'L2 merged', 18: 'L18 docs' }));
    git(home.path, 'add', '-A');
    git(home.path, 'commit', '-qm', 'resolved');
    const since = ctx.store.getSession(agent.id)!.notifiedIdx;
    await ctx.orch.message(parent, agent.id, 'done?');
    await reported(ctx, agent, since);
    await waitFor(() => ctx.store.worktreeOf(copy.id)!.state === 'mustered');
    expect(ctx.store.deliveriesOf(parent.id).map((d) => d.title)).toEqual(['API', 'Docs', 'Copy']);
    expect(await owner('app.txt', 'additions', 2, 'L2 merged')).toBeNull();
    // In one agent's own view, every line is that agent's.
    const mine = await ctx.orch.changes.anchor(docs.id, { path: 'base.txt', side: 'deletions', line: 2, lineText: 'drop' });
    expect(mine.ok && mine.owner).toEqual({ id: docs.id, title: 'Docs', harness: 'claude-code' });
  });

  it("shows an agent's committed, uncommitted and untracked work in its worktree", async () => {
    const ctx = start();
    const parent = await roundUp(ctx);
    const api = await writer(ctx, parent, 'API');
    const wt = ctx.store.worktreeOf(api.id)!;
    commit(api.cwd, 'committed.txt', 'one\n');
    writeFileSync(join(api.cwd, 'app.txt'), lines({ 3: 'L3 wip' }));
    writeFileSync(join(api.cwd, 'new.txt'), 'a\nb\n');
    const changes = (await ctx.orch.changes.of(api.id))!;
    expect(changes).toMatchObject({
      scope: 'agent',
      state: 'ready',
      roundUpId: parent.id,
      sessionId: api.id,
      branch: wt.branch,
      baseRef: ctx.store.worktreeOf(parent.id)!.branch,
      baseSha: wt.forkCommit,
      headSha: git(api.cwd, 'rev-parse', 'HEAD'),
      dirty: true,
      checkoutPath: wt.path,
      rounds: [{ index: 1, state: 'active', baseSha: wt.forkCommit }],
      round: 1,
    });
    expect(brief(changes.files)).toEqual([
      ['app.txt', 'modified', 1, 1, 'API'],
      ['committed.txt', 'added', 1, 0, 'API'],
      ['new.txt', 'added', 2, 0, 'API'],
    ]);
    expect(changes.files.find((f) => f.path === 'new.txt')!.patch).toContain('+++ b/new.txt');
    // The anchor reads the worktree's files, uncommitted lines included.
    expect((await ctx.orch.changes.anchor(api.id, { path: 'app.txt', side: 'additions', line: 3, lineText: 'L3 wip' })).ok).toBe(true);
    expect((await ctx.orch.changes.anchor(api.id, { path: 'new.txt', side: 'additions', line: 2, lineText: 'b' })).ok).toBe(true);
    // Readers and Muster have no diff of their own.
    const { agentId } = await ctx.orch.spawn(parent, { title: 'Look', task: 'x', writes: false });
    expect((await ctx.orch.changes.of(agentId))!.state).toBe('none');
    expect(await ctx.orch.changes.of('nope')).toBeUndefined();
  });

  it("takes a mustered agent's diff from its delivery, and shows a second round once it works again", async () => {
    const ctx = start();
    const { parent, api } = await twoMustered(ctx);
    const first = (await ctx.orch.changes.of(api.id))!;
    const [delivery] = ctx.store.deliveriesOf(parent.id);
    expect(first).toMatchObject({ state: 'ready', dirty: false, rounds: [{ index: 1, state: 'mustered', baseSha: delivery!.forkCommit, headSha: delivery!.tipCommit }], round: 1 });
    expect(first.checkoutPath).toBeUndefined();
    expect(brief(first.files)).toEqual([
      ['api.txt', 'added', 1, 0, 'API'],
      ['app.txt', 'modified', 1, 1, 'API'],
    ]);

    // Picked up again: its worktree comes back from the feature branch's tip, a new round.
    const since = ctx.store.getSession(api.id)!.notifiedIdx;
    await ctx.orch.message(parent, api.id, 'one more thing');
    await reported(ctx, api, since);
    expect(ctx.store.worktreeOf(api.id)!.state).toBe('active');
    commit(api.cwd, 'more.txt', 'more\n');
    const second = (await ctx.orch.changes.of(api.id))!;
    expect(second.rounds!.map((r) => [r.index, r.state])).toEqual([
      [1, 'mustered'],
      [2, 'active'],
    ]);
    expect(second.round).toBe(2);
    expect(brief(second.files)).toEqual([['more.txt', 'added', 1, 0, 'API']]);
    expect(brief((await ctx.orch.changes.of(api.id, { round: 1 }))!.files).map((f) => f[0])).toEqual(['api.txt', 'app.txt']);
    await expect(ctx.orch.changes.of(api.id, { round: 3 })).rejects.toThrow(/no round 3/);
  });

  it('records the delivery of a branch merged just before a crash when Kelpie starts again', async () => {
    const ctx = start();
    const parent = await roundUp(ctx);
    const api = await writer(ctx, parent, 'API');
    commit(api.cwd, 'api.txt', 'api\n');
    const row = ctx.store.worktreeOf(api.id)!;
    // Merged, but Kelpie stopped before it marked the branch mustered.
    git(ctx.store.worktreeOf(parent.id)!.path, 'merge', '-q', '--no-ff', '-m', 'Muster: API', row.branch);
    expect(ctx.store.deliveriesOf(parent.id)).toEqual([]);
    await ctx.orch.reconcile();
    expect(ctx.store.worktreeOf(api.id)!.state).toBe('mustered');
    expect(ctx.store.deliveriesOf(parent.id)).toMatchObject([{ sessionId: api.id, title: 'API', branch: row.branch, forkCommit: row.forkCommit }]);
    expect(brief((await ctx.orch.changes.of(parent.id))!.files)).toEqual([['api.txt', 'added', 1, 0, 'API']]);
  });

  it('flags binary and too-large files, and serves a large one on its own', async () => {
    const ctx = start();
    const parent = await roundUp(ctx);
    const api = await writer(ctx, parent, 'API');
    commit(api.cwd, 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]));
    commit(api.cwd, 'big.txt', Array.from({ length: 3500 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const changes = (await ctx.orch.changes.of(api.id))!;
    const logo = changes.files.find((f) => f.path === 'logo.png')!;
    const big = changes.files.find((f) => f.path === 'big.txt')!;
    expect(logo).toMatchObject({ binary: true, status: 'added' });
    expect(logo.patch).toBeUndefined();
    expect(big).toMatchObject({ binary: false, additions: 3500, tooLarge: true });
    expect(big.patch).toBeUndefined();
    const alone = (await ctx.orch.changes.file(api.id, 'big.txt'))!;
    expect(alone).toMatchObject({ path: 'big.txt', tooLarge: false, agents: [{ title: 'API' }] });
    expect(alone.patch).toContain('+line 3499');
    expect(await ctx.orch.changes.file(api.id, 'missing.txt')).toBeNull();
  });
});
