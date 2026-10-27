import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Store, WorktreeRow } from '@kelpie/store';
import { baseCommit, ownWork, Worktrees } from '../src/worktrees.js';

/**
 * The shapes a branch's history takes (reset, rebased, merged, cherry-picked, mustered, landed,
 * fast-forwarded), each in a plain git repo, and what is its own work in each: what its Changes,
 * muster and landing go by.
 */

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const c = (dir: string, file: string, msg: string, text = `${file}\n`) => {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', msg);
};
const sha = (dir: string, rev: string) => git(dir, 'rev-parse', rev);

/** origin with main (base.txt), cloned to R, and `feat` cut from origin/main. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'kelpie-own-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const R = join(root, 'R');
  execFileSync('git', ['clone', '-q', origin, R], { stdio: 'ignore' });
  git(R, 'checkout', '-q', '-b', 'main');
  c(R, 'base.txt', 'base');
  git(R, 'push', '-q', 'origin', 'main');
  git(R, 'branch', '-q', 'feat', 'origin/main');
  const add = (branch: string, from?: string) => {
    const dir = join(root, branch);
    if (from) git(R, 'branch', '-q', branch, from);
    git(R, 'worktree', 'add', '-q', dir, branch);
    return dir;
  };
  /** Main moves on in origin, and R fetches it. */
  const upstream = (...files: string[]) => {
    const M = join(root, `M${Math.random().toString(36).slice(2, 7)}`);
    execFileSync('git', ['clone', '-q', origin, M], { stdio: 'ignore' });
    for (const f of files) c(M, f, `main ${f}`);
    git(M, 'push', '-q', 'origin', 'main');
    git(R, 'fetch', '-q');
    return M;
  };
  return { root, R, origin, F: add('feat'), add, upstream, fork0: sha(R, 'feat') };
}

let rows = 0;
const row = (repoRoot: string, r: { kind: 'home' | 'agent'; branch: string; fork: string; parentBranch?: string; baseBranch?: string }): WorktreeRow =>
  ({
    id: ++rows,
    roundUpId: 'r',
    sessionId: `s-${r.branch}`,
    kind: r.kind,
    repoRoot,
    path: '/nonexistent',
    branch: r.branch,
    parentBranch: r.parentBranch ?? (r.kind === 'agent' ? 'feat' : (r.baseBranch ?? 'origin/main')),
    baseBranch: r.baseBranch ?? 'origin/main',
    baseCommit: r.fork,
    forkCommit: r.fork,
    deliver: 'muster',
    state: 'active',
    createdAt: 0,
    lastUsedAt: 0,
    removedAt: null,
  }) as WorktreeRow;

const wt = new Worktrees({ store: {} as Store, root: join(tmpdir(), 'kelpie-own-root') });

/** A row's own work at its branch's tip, by commit subject, with the files its diff shows. */
async function own(w: WorktreeRow) {
  const head = sha(w.repoRoot, `refs/heads/${w.branch}`);
  const work = await ownWork(w, head);
  const subject = (s: string) => git(w.repoRoot, 'log', '-1', '--format=%s', s);
  const base = await baseCommit(w.repoRoot, work.base);
  return {
    commits: work.commits.map(subject),
    merges: work.merges.map(subject),
    count: await wt.ownCommits(w),
    files: git(w.repoRoot, 'diff', '--name-only', base, head).split('\n').filter(Boolean),
  };
}

/** feat has "feat seed"; agent `ag` cut from it has a1, a2; main moved on by up1, up2. */
function agentWithWork() {
  const r = repo();
  c(r.F, 'seed.txt', 'feat seed');
  const fork = sha(r.R, 'feat');
  const A = r.add('ag', 'feat');
  c(A, 'a1.txt', 'agent a1');
  c(A, 'a2.txt', 'agent a2');
  const M = r.upstream('up1.txt', 'up2.txt');
  return { ...r, A, M, fork, ag: row(r.R, { kind: 'agent', branch: 'ag', fork }) };
}

describe('own work', () => {
  it('is nothing for a fresh agent, and its commits once it makes some', async () => {
    const r = repo();
    c(r.F, 'seed.txt', 'feat seed');
    const fork = sha(r.R, 'feat');
    const A = r.add('ag', 'feat');
    const ag = row(r.R, { kind: 'agent', branch: 'ag', fork });
    expect(await own(ag)).toEqual({ commits: [], merges: [], count: 0, files: [] });
    expect((await ownWork(ag, fork)).base).toBe(fork);
    c(A, 'a1.txt', 'agent a1');
    expect(await own(ag)).toEqual({ commits: ['agent a1'], merges: [], count: 1, files: ['a1.txt'] });
  });

  it('starts at the newer main a branch was reset onto', async () => {
    const s = agentWithWork();
    git(s.A, 'reset', '-q', '--hard', 'origin/main');
    expect(await own(s.ag)).toMatchObject({ commits: [], count: 0, files: [] });
    c(s.A, 'b1.txt', 'agent b1');
    expect(await own(s.ag)).toMatchObject({ commits: ['agent b1'], count: 1, files: ['b1.txt'] });
  });

  it("leaves out the feature's commits a rebase onto newer main replays, even if the feature amends them later", async () => {
    const s = agentWithWork();
    git(s.A, 'rebase', '-q', 'origin/main');
    expect(await own(s.ag)).toMatchObject({ commits: ['agent a2', 'agent a1'], count: 2, files: ['a1.txt', 'a2.txt'] });
    c(s.F, 'seed.txt', 'feat seed fix', 'seed2\n');
    expect(await own(s.ag)).toMatchObject({ commits: ['agent a2', 'agent a1'], files: ['a1.txt', 'a2.txt'] });
  });

  it('leaves out a newer main merged in, clean or resolved by hand, with no refs left behind', async () => {
    const s = agentWithWork();
    git(s.A, 'merge', '-q', '--no-edit', 'origin/main');
    const work = await ownWork(s.ag, sha(s.R, 'ag'));
    expect(work.base.split('+').sort()).toEqual([s.fork, sha(s.R, 'origin/main')].sort());
    expect(await own(s.ag)).toMatchObject({ commits: ['agent a2', 'agent a1'], count: 2, files: ['a1.txt', 'a2.txt'] });
    // The base's commit is made the same way each time, and no ref keeps it.
    expect(await baseCommit(s.R, work.base)).toBe(await baseCommit(s.R, work.base));
    expect(git(s.R, 'for-each-ref', 'refs/kelpie')).toBe('');
  });

  it('diffs a main merged with a conflict against the conflicted merge, so main is left out (s5)', async () => {
    const r = repo();
    const M = r.upstream('up1.txt', 'up2.txt');
    c(M, 'base.txt', 'main edits base', 'main edit\n');
    git(M, 'push', '-q');
    git(r.R, 'fetch', '-q');
    c(r.F, 'base.txt', 'feat edits base', 'feat edit\n');
    const fork = sha(r.R, 'feat');
    const A = r.add('ag', 'feat');
    c(A, 'b1.txt', 'agent b1');
    expect(() => git(A, 'merge', '--no-edit', 'origin/main')).toThrow();
    writeFileSync(join(A, 'base.txt'), 'resolved\n');
    git(A, 'commit', '-qam', 'merge main (resolved)');
    const ag = row(r.R, { kind: 'agent', branch: 'ag', fork });
    expect(await own(ag)).toEqual({ commits: ['agent b1'], merges: ['merge main (resolved)'], count: 1, files: ['b1.txt', 'base.txt'] });
  });

  it('leaves out the feature merged in after it moved on', async () => {
    const s = agentWithWork();
    c(s.F, 'f2.txt', 'feat f2');
    git(s.A, 'merge', '-q', '--no-edit', 'feat');
    c(s.A, 'a3.txt', 'agent a3');
    expect(await own(s.ag)).toMatchObject({ commits: ['agent a3', 'agent a2', 'agent a1'], count: 3, files: ['a1.txt', 'a2.txt', 'a3.txt'] });
  });

  it('keeps commits of its own that were cherry-picked elsewhere, wherever they sit (s3)', async () => {
    const newest = agentWithWork();
    git(newest.F, 'cherry-pick', sha(newest.R, 'ag'));
    expect(await own(newest.ag)).toMatchObject({ commits: ['agent a2', 'agent a1'], count: 2, files: ['a1.txt', 'a2.txt'] });

    const middle = agentWithWork();
    c(middle.A, 'a3.txt', 'agent a3');
    git(middle.F, 'cherry-pick', sha(middle.R, 'ag~1'));
    expect(await own(middle.ag)).toMatchObject({ commits: ['agent a3', 'agent a2', 'agent a1'], count: 3, files: ['a1.txt', 'a2.txt', 'a3.txt'] });

    const hotfix = agentWithWork();
    c(hotfix.A, 'a3.txt', 'agent a3');
    git(hotfix.M, 'pull', '-q');
    git(hotfix.M, 'fetch', '-q', hotfix.R, 'ag');
    git(hotfix.M, 'cherry-pick', 'FETCH_HEAD~1');
    git(hotfix.M, 'push', '-q');
    git(hotfix.R, 'fetch', '-q');
    expect(await own(hotfix.ag)).toMatchObject({ commits: ['agent a3', 'agent a2', 'agent a1'], files: ['a1.txt', 'a2.txt', 'a3.txt'] });

    const bottom = agentWithWork();
    git(bottom.F, 'cherry-pick', sha(bottom.R, 'ag~1'));
    expect(await own(bottom.ag)).toMatchObject({ commits: ['agent a2', 'agent a1'], files: ['a1.txt', 'a2.txt'] });
  });

  it('counts a branch pushed anywhere, and a sibling pushed, as before', async () => {
    const s = agentWithWork();
    git(s.R, 'remote', 'add', 'other', s.origin);
    git(s.A, 'push', '-q', 'other', 'HEAD:refs/heads/pr');
    git(s.A, 'push', '-q', 'origin', 'HEAD:main-copy');
    git(s.R, 'fetch', '-q', '--all');
    expect(await own(s.ag)).toMatchObject({ commits: ['agent a2', 'agent a1'], count: 2 });
    const home = row(s.R, { kind: 'home', branch: 'feat', fork: s.fork0 });
    git(s.R, 'push', '-q', 'origin', 'feat:sib');
    git(s.R, 'fetch', '-q');
    expect(await own(home)).toMatchObject({ commits: ['feat seed'], files: ['seed.txt'] });
  });

  it('keeps the feature its work through two landings on a local base and their pushes (s6)', async () => {
    const r = repo();
    git(r.R, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
    c(r.F, 'w1.txt', 'feat w1');
    const home = row(r.R, { kind: 'home', branch: 'feat', fork: r.fork0, baseBranch: 'main' });
    const one = { commits: ['feat w1'], merges: [], count: 1, files: ['w1.txt'] };
    expect(await own(home)).toEqual(one);
    git(r.R, 'merge', '-q', '--no-ff', '-m', 'land 1', 'feat');
    expect(await own(home)).toEqual(one);
    git(r.R, 'push', '-q', 'origin', 'main');
    git(r.R, 'fetch', '-q');
    expect(await own(home)).toEqual(one);
    c(r.F, 'w2.txt', 'feat w2');
    const two = { commits: ['feat w2', 'feat w1'], merges: [], count: 2, files: ['w1.txt', 'w2.txt'] };
    expect(await own(home)).toEqual(two);
    git(r.R, 'merge', '-q', '--no-ff', '-m', 'land 2', 'feat');
    expect(await own(home)).toEqual(two);
    git(r.R, 'push', '-q', 'origin', 'main');
    git(r.R, 'fetch', '-q');
    expect(await own(home)).toEqual(two);
  });

  it('keeps an agent all its work through two hand merges into the feature, and a revert of one (s6)', async () => {
    const r = repo();
    c(r.F, 'seed.txt', 'feat seed');
    const fork = sha(r.R, 'feat');
    const A = r.add('ag', 'feat');
    const ag = row(r.R, { kind: 'agent', branch: 'ag', fork });
    c(A, 'a1.txt', 'agent a1');
    git(r.F, 'merge', '-q', '--no-ff', '-m', 'Muster 1', 'ag');
    c(A, 'a2.txt', 'agent a2');
    expect(await own(ag)).toMatchObject({ commits: ['agent a2', 'agent a1'], files: ['a1.txt', 'a2.txt'] });
    git(r.F, 'merge', '-q', '--no-ff', '-m', 'Muster 2', 'ag');
    c(A, 'a3.txt', 'agent a3');
    const all = { commits: ['agent a3', 'agent a2', 'agent a1'], count: 3, files: ['a1.txt', 'a2.txt', 'a3.txt'] };
    expect(await own(ag)).toMatchObject(all);
    git(r.F, 'revert', '--no-edit', '-m', '1', 'HEAD');
    expect(await own(ag)).toMatchObject(all);
  });

  it('takes a remote-only base, and a local base with no upstream, against origin (s6)', async () => {
    const r = repo();
    c(r.F, 'w.txt', 'feat w');
    git(r.R, 'checkout', '-q', '--detach');
    git(r.R, 'branch', '-q', '-D', 'main');
    expect(await own(row(r.R, { kind: 'home', branch: 'feat', fork: r.fork0, baseBranch: 'origin/main' }))).toMatchObject({ commits: ['feat w'], files: ['w.txt'] });

    // A local main with no upstream: origin's main still counts, so main merged from it is left out.
    const s = repo();
    git(s.R, 'branch', '-q', '--unset-upstream', 'main');
    c(s.F, 'w.txt', 'feat w');
    s.upstream('up.txt');
    git(s.F, 'merge', '-q', '--no-edit', 'origin/main');
    expect(await own(row(s.R, { kind: 'home', branch: 'feat', fork: s.fork0, baseBranch: 'main' }))).toMatchObject({ commits: ['feat w'], files: ['w.txt'] });
  });

  it('keeps the feature its work when origin merged it as a PR and local main pulled that with a merge (s7)', async () => {
    const r = repo();
    git(r.R, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
    c(r.F, 'w1.txt', 'feat w1');
    c(r.R, 'local.txt', 'local main commit');
    const home = row(r.R, { kind: 'home', branch: 'feat', fork: r.fork0, baseBranch: 'main' });
    const one = { commits: ['feat w1'], merges: [], count: 1, files: ['w1.txt'] };
    expect(await own(home)).toEqual(one);
    const M = r.upstream();
    git(M, 'fetch', '-q', r.R, 'feat:feat');
    git(M, 'merge', '-q', '--no-ff', '-m', 'PR merge', 'feat');
    git(M, 'push', '-q', 'origin', 'main');
    git(r.R, 'fetch', '-q');
    expect(await own(home)).toEqual(one);
    git(r.R, 'pull', '-q', '--no-rebase', '--no-ff', '--no-edit');
    expect(await own(home)).toEqual(one);
  });

  it("doesn't credit an agent with a sibling's work it merged once the sibling is mustered (s8 #16)", async () => {
    const r = repo();
    c(r.F, 'seed.txt', 'feat seed');
    const fork = sha(r.R, 'feat');
    const A = r.add('ag', 'feat');
    const S = r.add('sib', 'feat');
    c(S, 's1.txt', 'sib s1');
    c(A, 'a1.txt', 'agent a1');
    git(A, 'merge', '-q', '--no-edit', 'sib');
    const ag = row(r.R, { kind: 'agent', branch: 'ag', fork });
    // Not mustered yet, the sibling's work comes with this branch.
    const before = await own(ag);
    expect(before.commits.sort()).toEqual(['agent a1', 'sib s1']);
    expect(before.files).toEqual(['a1.txt', 's1.txt']);
    git(r.F, 'merge', '-q', '--no-ff', '-m', 'Muster: sib', 'sib');
    expect(await own(ag)).toMatchObject({ commits: ['agent a1'], count: 1, files: ['a1.txt'] });
    c(A, 'a2.txt', 'agent a2');
    expect(await own(ag)).toMatchObject({ commits: ['agent a2', 'agent a1'], count: 2, files: ['a1.txt', 'a2.txt'] });
  });

  it('keeps an agent its work when it reaches the feature through a sibling, and sees it mustered (s8 #17)', async () => {
    const r = repo();
    c(r.F, 'seed.txt', 'feat seed');
    const fork = sha(r.R, 'feat');
    const A = r.add('ag', 'feat');
    const S = r.add('sib', 'feat');
    c(A, 'a1.txt', 'agent a1');
    c(S, 's1.txt', 'sib s1');
    git(S, 'merge', '-q', '--no-edit', 'ag');
    git(r.F, 'merge', '-q', '--no-ff', '-m', 'Muster: sib', 'sib');
    const ag = row(r.R, { kind: 'agent', branch: 'ag', fork });
    expect(await own(ag)).toMatchObject({ commits: ['agent a1'], count: 1, files: ['a1.txt'] });
    expect(await wt.musteredIn(ag, row(r.R, { kind: 'home', branch: 'feat', fork: r.fork0 }))).toBe(true);
  });

  it('keeps an agent its work when the feature fast-forwards onto it, and sees it mustered (s11)', async () => {
    const r = repo();
    c(r.F, 'seed.txt', 'feat seed');
    const fork = sha(r.R, 'feat');
    const A = r.add('ag', 'feat');
    c(A, 'a1.txt', 'agent a1');
    git(r.F, 'merge', '-q', '--ff-only', 'ag');
    const ag = row(r.R, { kind: 'agent', branch: 'ag', fork });
    expect(await own(ag)).toMatchObject({ commits: ['agent a1'], count: 1, files: ['a1.txt'] });
    expect(await wt.musteredIn(ag, row(r.R, { kind: 'home', branch: 'feat', fork: r.fork0 }))).toBe(true);
  });

  it("doesn't take the feature's musters as an agent's when it fast-forwards onto the feature with nothing of its own", async () => {
    const r = repo();
    const fork = sha(r.R, 'feat');
    const A = r.add('ag', 'feat');
    const S = r.add('sib', 'feat');
    c(S, 's1.txt', 'sib s1');
    git(r.F, 'merge', '-q', '--no-ff', '-m', 'Muster: sib', 'sib');
    git(A, 'merge', '-q', '--ff-only', 'feat');
    expect(await own(row(r.R, { kind: 'agent', branch: 'ag', fork }))).toMatchObject({ commits: [], count: 0, files: [] });
  });

  it("counts merges alone as work only if they change something: an evil merge does, main merged doesn't", async () => {
    const clean = agentWithWork();
    git(clean.A, 'reset', '-q', '--hard', clean.fork);
    git(clean.A, 'merge', '-q', '--no-edit', 'origin/main');
    expect(await own(clean.ag)).toMatchObject({ commits: [], count: 0, files: [] });
    const evil = agentWithWork();
    git(evil.A, 'reset', '-q', '--hard', evil.fork);
    git(evil.A, 'merge', '-q', '--no-commit', 'origin/main');
    writeFileSync(join(evil.A, 'evil.txt'), 'evil\n');
    git(evil.A, 'add', '-A');
    git(evil.A, 'commit', '-qm', 'merge main + evil');
    expect(await own(evil.ag)).toMatchObject({ commits: [], count: 1, files: ['evil.txt'] });
  });

  it('fails loudly when git does, and caches no answer from it (finding 6)', async () => {
    const s = agentWithWork();
    const head = sha(s.R, 'ag');
    const a1 = sha(s.R, 'ag~1');
    const object = join(s.R, '.git', 'objects', a1.slice(0, 2), a1.slice(2));
    const kept = join(s.root, 'a1-object');
    copyFileSync(object, kept);
    renameSync(object, `${object}.gone`);
    await expect(ownWork(s.ag, head)).rejects.toThrow();
    await expect(wt.ownCommits(s.ag)).rejects.toThrow();
    copyFileSync(kept, object);
    expect((await ownWork(s.ag, head)).commits).toHaveLength(2);
  });
});
