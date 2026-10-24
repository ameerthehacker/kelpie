import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore, type Store } from '@kelpie/store';
import { Worktrees } from '../src/worktrees.js';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const commit = (cwd: string, file: string, text: string, msg = file) => {
  writeFileSync(join(cwd, file), text);
  run(cwd, 'add', '-A');
  run(cwd, 'commit', '-qm', msg);
};

/** An "origin" with main and release, cloned into a checkout that sits on some other branch. */
function setup(now = { t: 1_000 }) {
  const origin = tmp('kelpie-origin-');
  run(origin, 'init', '-q', '--bare', '-b', 'main');
  const seed = tmp('kelpie-seed-');
  run(seed, 'init', '-q', '-b', 'main');
  commit(seed, 'app.txt', 'one\ntwo\nthree\n');
  run(seed, 'remote', 'add', 'origin', origin);
  run(seed, 'push', '-q', 'origin', 'main');
  run(seed, 'checkout', '-qb', 'release');
  commit(seed, 'release.txt', 'r1\n');
  run(seed, 'push', '-q', 'origin', 'release');
  const repo = join(tmp('kelpie-clone-'), 'acme');
  run(tmpdir(), 'clone', '-q', origin, repo);
  run(repo, 'config', 'user.email', 't@t');
  run(repo, 'config', 'user.name', 't');
  run(repo, 'checkout', '-qb', 'my-local-thing');
  commit(repo, 'local.txt', 'not for the round-up\n');
  const store = openStore(':memory:');
  store.createSession({ id: 'orch-1234567890', cwd: repo, title: 'Ship guest checkout' });
  store.createSession({ id: 'agent-a-123456', cwd: repo, title: 'API', parentId: 'orch-1234567890', role: 'agent', writes: true });
  store.createSession({ id: 'agent-b-123456', cwd: repo, title: 'UI', parentId: 'orch-1234567890', role: 'agent', writes: true });
  const wt = new Worktrees({ store, root: join(tmp('kelpie-home-'), 'worktrees'), now: () => now.t, idleMs: 1000, max: 3 });
  return { origin, seed, repo, store, wt, now };
}

const roundUp = (store: Store, baseBranch: string, baseCommit: string) => ({ id: 'orch-1234567890', title: store.getSession('orch-1234567890')!.title, baseBranch, baseCommit });

describe('Worktrees', () => {
  it('lists remote branches first, and pins a remote base by fetching it', async () => {
    const { seed, repo, wt } = setup();
    expect(await wt.repoOf(repo)).toBe(realpathSync(repo));
    expect(await wt.repoOf(tmpdir())).toBeUndefined();
    const branches = await wt.branches(repo);
    expect(branches.filter((b) => b.remote).map((b) => b.name).sort()).toEqual(['origin/main', 'origin/release']);
    expect(branches.findIndex((b) => !b.remote)).toBeGreaterThan(branches.findLastIndex((b) => b.remote));
    // The remote moved on after the clone: pinning fetches, so the base is what origin has now.
    commit(seed, 'release2.txt', 'r2\n');
    run(seed, 'push', '-q', 'origin', 'release');
    expect(await wt.pinBase(repo, 'origin/release')).toBe(run(seed, 'rev-parse', 'HEAD'));
    await expect(wt.pinBase(repo, '--upload-pack=evil')).rejects.toThrow(/not a branch name/);
    await expect(wt.pinBase(repo, 'origin/nope')).rejects.toThrow();
  });

  it('cuts home from the pinned base, not from the checkout, and agents from home, with flat branch names', async () => {
    const { repo, store, wt } = setup();
    const base = await wt.pinBase(repo, 'origin/main');
    const home = await wt.ensureHome(roundUp(store, 'origin/main', base), repo);
    expect(home).toMatchObject({ kind: 'home', state: 'active', branch: 'kelpie/ship-guest-checkout-orch-1', parentBranch: 'origin/main', baseCommit: base });
    expect(run(home.path, 'rev-parse', 'HEAD')).toBe(base);
    expect(existsSync(join(home.path, 'local.txt'))).toBe(false);
    const a = await wt.createAgent({ id: 'agent-a-123456', title: 'Checkout API' }, home, 'muster');
    expect(a).toMatchObject({ branch: 'kelpie/ship-guest-checkout-orch-1--checkout-api-agent-', parentBranch: home.branch, baseBranch: 'origin/main', deliver: 'muster' });
    expect(run(a.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(a.branch);
    // Asking again gives the same home.
    expect((await wt.ensureHome(roundUp(store, 'origin/main', base), repo)).path).toBe(home.path);
  });

  it('brings a swept worktree back at the same path, on its branch', async () => {
    const { repo, store, wt } = setup();
    const home = await wt.ensureHome(roundUp(store, 'origin/main', await wt.pinBase(repo, 'origin/main')), repo);
    const a = await wt.createAgent({ id: 'agent-a-123456', title: 'API' }, home, 'muster');
    commit(a.path, 'api.txt', 'api\n');
    await wt.remove(a);
    expect(existsSync(a.path)).toBe(false);
    const back = await wt.ensure(store.worktreeOf('agent-a-123456')!);
    expect(back).toMatchObject({ path: a.path, state: 'active' });
    expect(existsSync(join(back.path, 'api.txt'))).toBe(true);
  });

  it('checkpoints uncommitted work, merges clean branches, and backs out of conflicts', async () => {
    const { repo, store, wt } = setup();
    const home = await wt.ensureHome(roundUp(store, 'origin/main', await wt.pinBase(repo, 'origin/main')), repo);
    const a = await wt.createAgent({ id: 'agent-a-123456', title: 'API' }, home, 'muster');
    const b = await wt.createAgent({ id: 'agent-b-123456', title: 'UI' }, home, 'muster');
    writeFileSync(join(a.path, 'app.txt'), 'one\nTWO by api\nthree\n');
    expect(await wt.checkpoint(a, 'API')).toBe(true);
    expect(run(a.path, 'log', '-1', '--format=%s')).toBe('kelpie: checkpoint (API)');
    expect(await wt.checkpoint(a, 'API')).toBe(false);
    commit(b.path, 'app.txt', 'one\nTWO by ui\nthree\n');
    expect(await wt.stats(a, home.branch)).toEqual({ ahead: 1, diffstat: '1 file changed, 1 insertion(+), 1 deletion(-)', dirty: false });

    expect(await wt.merge(home, a.branch, 'Muster: API')).toEqual({ ok: true });
    expect(await wt.isMerged(repo, a.branch, home.branch)).toBe(true);
    expect(await wt.merge(home, b.branch, 'Muster: UI')).toEqual({ ok: false, conflicts: ['app.txt'] });
    // Backed out: home is clean and still at the first merge.
    expect(run(home.path, 'status', '--porcelain')).toBe('');
    expect(await wt.isMerged(repo, b.branch, home.branch)).toBe(false);

    await wt.mustered(a, home);
    expect(store.worktreeOf('agent-a-123456')).toMatchObject({ state: 'mustered' });
    expect(run(repo, 'branch', '--list', a.branch)).toBe('');
  });

  it('sweeps only idle, clean worktrees, and makes room under the cap', async () => {
    const { repo, store, wt, now } = setup();
    const home = await wt.ensureHome(roundUp(store, 'origin/main', await wt.pinBase(repo, 'origin/main')), repo);
    const a = await wt.createAgent({ id: 'agent-a-123456', title: 'API' }, home, 'muster');
    const b = await wt.createAgent({ id: 'agent-b-123456', title: 'UI' }, home, 'standalone');
    writeFileSync(join(b.path, 'wip.txt'), 'unsaved\n');
    expect(await wt.sweep(() => false)).toBe(0); // not idle yet
    now.t += 5_000;
    // Home is in use; A is idle and clean; B is idle but dirty.
    expect(await wt.sweep((row) => row.sessionId === home.sessionId)).toBe(1);
    expect(store.worktreeOf(a.sessionId)!.state).toBe('removed');
    expect(existsSync(b.path)).toBe(true);
    // Branches stay when swept.
    expect(run(repo, 'branch', '--list', a.branch)).toContain(a.branch);

    // Cap of 3 with home + B live (A swept): room for one more; at the cap, only a clean idle one can go.
    expect(await wt.makeRoom(() => false)).toBe(true);
    await wt.ensure(store.worktreeOf(a.sessionId)!);
    expect(await wt.makeRoom((row) => row.sessionId !== home.sessionId)).toBe(true); // home is clean and not in use
    expect(store.worktreeOf(home.sessionId)!.state).toBe('removed');
  });

  it('on deleting a round-up, removes its worktrees and keeps only branches with unmerged work', async () => {
    const { repo, store, wt } = setup();
    const home = await wt.ensureHome(roundUp(store, 'origin/main', await wt.pinBase(repo, 'origin/main')), repo);
    const a = await wt.createAgent({ id: 'agent-a-123456', title: 'API' }, home, 'muster');
    const b = await wt.createAgent({ id: 'agent-b-123456', title: 'UI' }, home, 'standalone');
    commit(a.path, 'api.txt', 'api\n');
    await wt.merge(home, a.branch, 'Muster: API');
    writeFileSync(join(b.path, 'ui.txt'), 'unsaved ui\n'); // only on disk: kept by a checkpoint
    const kept = await wt.removeRoundUp('orch-1234567890');
    expect(kept.sort()).toEqual([b.branch, home.branch].sort());
    for (const p of [home.path, a.path, b.path]) expect(existsSync(p)).toBe(false);
    expect(run(repo, 'branch', '--list', a.branch)).toBe('');
    expect(run(repo, 'show', `${b.branch}:ui.txt`)).toBe('unsaved ui');
    expect(run(repo, 'worktree', 'list').split('\n')).toHaveLength(1); // only the checkout itself
    expect(existsSync(join(home.path, '..'))).toBe(false); // nor its empty folder
  });

  it('reconciles after a crash: missing dirs, half-made rows, strays, and an abandoned merge', async () => {
    const { repo, store, wt } = setup();
    const home = await wt.ensureHome(roundUp(store, 'origin/main', await wt.pinBase(repo, 'origin/main')), repo);
    const a = await wt.createAgent({ id: 'agent-a-123456', title: 'API' }, home, 'muster');
    const b = await wt.createAgent({ id: 'agent-b-123456', title: 'UI' }, home, 'muster');
    commit(a.path, 'app.txt', 'A\n');
    commit(b.path, 'app.txt', 'B\n');
    run(home.path, 'merge', '--no-edit', a.branch);
    expect(() => run(home.path, 'merge', '--no-edit', b.branch)).toThrow(); // left mid-conflict
    execFileSync('rm', ['-rf', b.path]); // gone by hand
    const stray = join(wt.root, 'acme-deadbeef', 'zzzz', 'old');
    mkdirSync(stray, { recursive: true });

    await wt.reconcile(() => false);
    expect(store.worktreeOf(b.sessionId)!.state).toBe('removed');
    expect(existsSync(stray)).toBe(false);
    expect(run(home.path, 'status', '--porcelain')).toBe('');
    expect(existsSync(a.path)).toBe(true);
  });

  it('leaves a worktree alone if work started in it while the sweep looked, and never makes room with the one kept', async () => {
    const { repo, store, wt, now } = setup();
    const home = await wt.ensureHome(roundUp(store, 'origin/main', await wt.pinBase(repo, 'origin/main')), repo);
    const a = await wt.createAgent({ id: 'agent-a-123456', title: 'API' }, home, 'muster');
    now.t += 5_000;
    // Free when first looked at, busy by the time it would go.
    let looks = 0;
    expect(await wt.sweep((row) => row.id === a.id && ++looks > 1)).toBe(1); // home went; A stayed
    expect(existsSync(a.path)).toBe(true);
    await wt.ensure(store.worktreeOf(home.sessionId)!);
    // Cap 3, two live: room for two more means one must go, but home is kept and A is the only other.
    expect(await wt.makeRoom(() => false, 2, (row) => row.kind === 'home')).toBe(true);
    expect(store.worktreeOf(home.sessionId)!.state).toBe('active');
    expect(store.worktreeOf(a.sessionId)!.state).toBe('removed');
  });

  it('commits what a stray worktree holds before removing it', async () => {
    const { repo, store, wt } = setup();
    const home = await wt.ensureHome(roundUp(store, 'origin/main', await wt.pinBase(repo, 'origin/main')), repo);
    const a = await wt.createAgent({ id: 'agent-a-123456', title: 'API' }, home, 'muster');
    writeFileSync(join(a.path, 'wip.txt'), 'unsaved\n');
    store.deleteSession('agent-a-123456'); // its row goes with it: the directory is now a stray
    await wt.reconcile(() => false);
    expect(existsSync(a.path)).toBe(false);
    expect(run(repo, 'show', `${a.branch}:wip.txt`)).toBe('unsaved');
  });
});
