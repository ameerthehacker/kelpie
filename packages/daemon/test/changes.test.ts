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
  describe('base: only the work of its own', () => {
    /** Main moves on in origin: `n` commits, each adding a file, fetched into the repo. */
    let upstream = 0;
    const mainMovesOn = (ctx: Ctx, n: number) => {
      for (let i = 0; i < n; i++, upstream++) commit(ctx.checkout, `upstream-${upstream}.txt`, `upstream ${upstream}\n`);
      git(ctx.checkout, 'push', '-q', 'origin', 'HEAD:main');
      git(ctx.checkout, 'fetch', '-q', 'origin');
      return git(ctx.checkout, 'rev-parse', 'origin/main');
    };

    it('shows nothing for a fresh agent', async () => {
      const ctx = start();
      const parent = await roundUp(ctx);
      const api = await writer(ctx, parent, 'API');
      const changes = (await ctx.orch.changes.of(api.id))!;
      expect(changes).toMatchObject({ state: 'ready', baseSha: ctx.store.worktreeOf(api.id)!.forkCommit, stats: { files: 0, additions: 0, deletions: 0 } });
    });

    it("leaves out a newer main an agent's branch was reset onto, keeping its committed and uncommitted work", async () => {
      const ctx = start();
      const parent = await roundUp(ctx);
      const api = await writer(ctx, parent, 'API');
      const row = ctx.store.worktreeOf(api.id)!;
      const main = mainMovesOn(ctx, 5);
      git(api.cwd, 'reset', '-q', '--hard', 'origin/main');

      // Nothing of its own yet: main's five commits are not its changes.
      const fresh = (await ctx.orch.changes.of(api.id))!;
      expect(fresh).toMatchObject({ baseSha: main, headSha: main, stats: { files: 0 } });
      expect(await ctx.worktrees.ownCommits(row)).toBe(0);
      expect(await ctx.worktrees.stats(row)).toEqual({ ahead: 0, diffstat: '', dirty: false });

      commit(api.cwd, 'api.txt', 'api\n');
      commit(api.cwd, 'app.txt', lines({ 4: 'L4 api' }));
      writeFileSync(join(api.cwd, 'base.txt'), 'keep\ndrop\nend\nwip\n');
      const work = (await ctx.orch.changes.of(api.id))!;
      expect(work).toMatchObject({ baseSha: main, dirty: true, rounds: [{ index: 1, state: 'active', baseSha: main }] });
      expect(brief(work.files)).toEqual([
        ['api.txt', 'added', 1, 0, 'API'],
        ['app.txt', 'modified', 1, 1, 'API'],
        ['base.txt', 'modified', 1, 0, 'API'],
      ]);
      expect(await ctx.worktrees.ownCommits(row)).toBe(2);
      // Main moving on again (and fetched) changes nothing.
      mainMovesOn(ctx, 1);
      expect((await ctx.orch.changes.of(api.id))!.baseSha).toBe(main);

      // Mustered, its delivery starts there too: the feature's changes put only its files down to it,
      // and the feature's own diff leaves out the main it brought in.
      git(api.cwd, 'checkout', '-q', '--', 'base.txt');
      const { merged } = await ctx.orch.muster(parent, [api.id]);
      expect(merged).toEqual(['API']);
      expect(ctx.store.deliveriesOf(parent.id)).toMatchObject([{ forkCommit: main }]);
      const feature = (await ctx.orch.changes.of(parent.id))!;
      expect(brief(feature.files)).toEqual([
        ['api.txt', 'added', 1, 0, 'API'],
        ['app.txt', 'modified', 1, 1, 'API'],
      ]);
      expect(feature.baseSha).toBe(main);
    });

    it('leaves out the feature branch moving on, merged into an agent or not', async () => {
      const ctx = start();
      const parent = await roundUp(ctx);
      const api = await writer(ctx, parent, 'API');
      const docs = await writer(ctx, parent, 'Docs');
      commit(api.cwd, 'api.txt', 'api\n');
      commit(docs.cwd, 'docs.txt', 'docs\n');
      expect((await ctx.orch.muster(parent, [api.id])).merged).toEqual(['API']);
      const home = ctx.store.worktreeOf(parent.id)!;
      expect(brief((await ctx.orch.changes.of(docs.id))!.files)).toEqual([['docs.txt', 'added', 1, 0, 'Docs']]);

      git(docs.cwd, 'merge', '-q', '--no-edit', home.branch);
      commit(docs.cwd, 'more.txt', 'more\n');
      const changes = (await ctx.orch.changes.of(docs.id))!;
      expect(changes.baseSha).toBe(git(home.path, 'rev-parse', 'HEAD'));
      expect(brief(changes.files)).toEqual([
        ['docs.txt', 'added', 1, 0, 'Docs'],
        ['more.txt', 'added', 1, 0, 'Docs'],
      ]);
      expect(await ctx.worktrees.stats(ctx.store.worktreeOf(docs.id)!)).toMatchObject({ diffstat: '2 files changed, 2 insertions(+)' });
    });

    it("leaves out main merged into the feature branch from its diff", async () => {
      const ctx = start();
      const parent = await roundUp(ctx);
      const api = await writer(ctx, parent, 'API');
      commit(api.cwd, 'api.txt', 'api\n');
      await ctx.orch.muster(parent, [api.id]);
      const home = ctx.store.worktreeOf(parent.id)!;
      mainMovesOn(ctx, 3);
      git(home.path, 'merge', '-q', '--no-edit', 'origin/main');
      const feature = (await ctx.orch.changes.of(parent.id))!;
      expect(feature.baseSha).toBe(git(ctx.checkout, 'rev-parse', 'origin/main'));
      expect(brief(feature.files)).toEqual([['api.txt', 'added', 1, 0, 'API']]);
    });
    it('shows only committed work while a merge or rebase is under way, never commits it as a checkpoint, and refuses to muster it (n4)', async () => {
      const ctx = start();
      const parent = await roundUp(ctx);
      const api = await writer(ctx, parent, 'API');
      const row = ctx.store.worktreeOf(api.id)!;
      commit(api.cwd, 'api.txt', 'api\n');
      commit(api.cwd, 'base.txt', 'agent\n');
      git(ctx.checkout, 'pull', '-q');
      commit(ctx.checkout, 'base.txt', 'main\n');
      mainMovesOn(ctx, 1);
      expect(() => git(api.cwd, 'merge', '--no-edit', 'origin/main')).toThrow();

      const merging = (await ctx.orch.changes.of(api.id))!;
      expect(merging).toMatchObject({ inProgress: 'merge', dirty: false, headSha: git(api.cwd, 'rev-parse', 'HEAD') });
      expect(merging.files.map((f) => f.path)).toEqual(['api.txt', 'base.txt']);
      expect(await ctx.worktrees.checkpoint(row, 'test')).toBe(false);
      expect(git(api.cwd, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toBeTruthy();
      expect(await ctx.worktrees.dirty(row.path)).toBe(true);
      await expect(ctx.orch.muster(parent, [api.id])).rejects.toThrow(/merge in progress/);
      git(api.cwd, 'merge', '--abort');

      // A rebase stopped part way: its branch, not the detached HEAD, is its work.
      const tip = git(api.cwd, 'rev-parse', 'HEAD');
      expect(() => git(api.cwd, 'rebase', 'origin/main')).toThrow();
      const rebasing = (await ctx.orch.changes.of(api.id))!;
      expect(rebasing).toMatchObject({ inProgress: 'rebase', headSha: tip });
      expect(rebasing.files.map((f) => f.path)).toEqual(['api.txt', 'base.txt']);
      expect(await ctx.worktrees.checkpoint(row, 'test')).toBe(false);
      git(api.cwd, 'rebase', '--abort');
      expect((await ctx.orch.changes.of(api.id))!.inProgress).toBeUndefined();
    });

    it('keeps an agent its work when its branch is pushed anywhere, and muster takes it', async () => {
      const ctx = start();
      const parent = await roundUp(ctx);
      const api = await writer(ctx, parent, 'API');
      commit(api.cwd, 'api.txt', 'api\n');
      git(api.cwd, 'push', '-q', 'origin', 'HEAD:my-pr');
      git(api.cwd, 'fetch', '-q', 'origin');
      const row = ctx.store.worktreeOf(api.id)!;
      expect(brief((await ctx.orch.changes.of(api.id))!.files)).toEqual([['api.txt', 'added', 1, 0, 'API']]);
      expect(await ctx.worktrees.ownCommits(row)).toBe(1);
      expect(await ctx.worktrees.stats(row)).toMatchObject({ ahead: 1, diffstat: '1 file changed, 1 insertion(+)' });
      expect((await ctx.orch.muster(parent, [api.id])).merged).toEqual(['API']);
      expect(brief((await ctx.orch.changes.of(parent.id))!.files)).toEqual([['api.txt', 'added', 1, 0, 'API']]);
    });

    it("keeps the feature its work when a sibling's branch holding it is pushed", async () => {
      const ctx = start();
      const parent = await roundUp(ctx);
      const api = await writer(ctx, parent, 'API');
      commit(api.cwd, 'api.txt', 'api\n');
      await ctx.orch.muster(parent, [api.id]);
      // Cut after the muster, its branch has API's work; pushed, it is on a remote branch.
      const docs = await writer(ctx, parent, 'Docs', 'standalone');
      commit(docs.cwd, 'docs.txt', 'docs\n');
      git(docs.cwd, 'push', '-q', 'origin', 'HEAD:docs-pr');
      git(docs.cwd, 'fetch', '-q', 'origin');
      expect(brief((await ctx.orch.changes.of(parent.id))!.files)).toEqual([['api.txt', 'added', 1, 0, 'API']]);
      expect(brief((await ctx.orch.changes.of(docs.id))!.files)).toEqual([['docs.txt', 'added', 1, 0, 'Docs']]);
    });

    it('keeps the feature its changes once it has landed on a local base, and once that is pushed', async () => {
      const ctx = start();
      const parent = ctx.sessions.create();
      await parent.send('Ship it');
      await waitFor(() => parent.lastTurn && !parent.working);
      await ctx.orch.setBase(parent, 'main');
      const api = await writer(ctx, parent, 'API');
      commit(api.cwd, 'api.txt', 'api\n');
      await ctx.orch.muster(parent, [api.id]);
      const before = (await ctx.orch.changes.of(parent.id))!;
      expect(brief(before.files)).toEqual([['api.txt', 'added', 1, 0, 'API']]);

      const home = ctx.store.worktreeOf(parent.id)!;
      git(ctx.checkout, 'merge', '-q', '--no-ff', '-m', 'land', home.branch);
      commit(ctx.checkout, 'after.txt', 'after\n');
      const landed = (await ctx.orch.changes.of(parent.id))!;
      expect(landed.baseSha).toBe(before.baseSha);
      expect(brief(landed.files)).toEqual([['api.txt', 'added', 1, 0, 'API']]);
      git(ctx.checkout, 'push', '-q', 'origin', 'main');
      git(ctx.checkout, 'fetch', '-q', 'origin');
      expect(brief((await ctx.orch.changes.of(parent.id))!.files)).toEqual([['api.txt', 'added', 1, 0, 'API']]);
    });

    it('leaves out a newer main merged into an agent, the same base before and after muster', async () => {
      const ctx = start();
      const parent = await roundUp(ctx);
      // The feature has work of its own, so its agents' forks are not on main.
      const seed = await writer(ctx, parent, 'Seed');
      commit(seed.cwd, 'seed.txt', 'seed\n');
      await ctx.orch.muster(parent, [seed.id]);
      const api = await writer(ctx, parent, 'API');
      const only = await writer(ctx, parent, 'Catch-up');
      commit(api.cwd, 'api.txt', 'api\n');
      commit(api.cwd, 'app.txt', lines({ 4: 'L4 api' }));
      const main = mainMovesOn(ctx, 3);
      git(api.cwd, 'merge', '-q', '--no-edit', 'origin/main');
      const changes = (await ctx.orch.changes.of(api.id))!;
      expect(brief(changes.files)).toEqual([
        ['api.txt', 'added', 1, 0, 'API'],
        ['app.txt', 'modified', 1, 1, 'API'],
      ]);
      // Diffed against its fork and main merged, a commit Kelpie made (the same one each time).
      expect([ctx.store.worktreeOf(api.id)!.forkCommit, main]).not.toContain(changes.baseSha);
      expect((await ctx.orch.changes.of(api.id))!.baseSha).toBe(changes.baseSha);
      expect(await ctx.worktrees.ownCommits(ctx.store.worktreeOf(api.id)!)).toBe(2);

      // Merging main and nothing else is nothing to show or muster.
      git(only.cwd, 'merge', '-q', '--no-edit', 'origin/main');
      expect((await ctx.orch.changes.of(only.id))!.stats.files).toBe(0);
      expect(await ctx.worktrees.ownCommits(ctx.store.worktreeOf(only.id)!)).toBe(0);
      await expect(ctx.orch.muster(parent, [only.id])).rejects.toThrow(/nothing to muster/);

      // Mustered, its delivery is diffed from the same base, so its threads keep their round.
      await ctx.orch.muster(parent, [api.id]);
      expect(ctx.store.deliveriesOf(parent.id).find((d) => d.sessionId === api.id)).toMatchObject({ forkCommit: changes.baseSha });
      expect(brief((await ctx.orch.changes.of(api.id))!.files).map((f) => f[0])).toEqual(['api.txt', 'app.txt']);
    });

    it("leaves out main and the feature's own work when an agent rebases onto a newer main", async () => {
      const ctx = start();
      const parent = await roundUp(ctx);
      const api = await writer(ctx, parent, 'API');
      commit(api.cwd, 'api.txt', 'api\n');
      await ctx.orch.muster(parent, [api.id]);
      const docs = await writer(ctx, parent, 'Docs');
      commit(docs.cwd, 'docs.txt', 'docs\n');
      mainMovesOn(ctx, 2);
      git(docs.cwd, 'rebase', '-q', 'origin/main');
      expect(git(docs.cwd, 'log', '--format=%s', '-3')).toBe('edit docs.txt\nedit api.txt\nedit upstream-1.txt'.replace('upstream-1', `upstream-${upstream - 1}`));
      expect(brief((await ctx.orch.changes.of(docs.id))!.files)).toEqual([['docs.txt', 'added', 1, 0, 'Docs']]);
      expect(await ctx.worktrees.ownCommits(ctx.store.worktreeOf(docs.id)!)).toBe(1);
    });
  });
});
