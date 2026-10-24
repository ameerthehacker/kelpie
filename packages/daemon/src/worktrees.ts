import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { Store, WorktreeRow } from '@kelpie/store';

/** A git command that failed; `stderr` says why. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

interface Git {
  stdout: string;
  code: number;
  stderr: string;
}

/** How long one git command may take; a fetch gets longer. */
const GIT_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 120_000;

/**
 * Runs git without a shell, and never lets it wait on a person: no credential prompts, ssh in
 * batch mode (an unknown host or a key passphrase fails instead of asking), and a time limit.
 */
function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<Git> {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    // The person's own ssh settings win; otherwise ssh may not prompt either.
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
    LC_ALL: 'C',
  };
  return new Promise((done) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, env, timeout, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      const timedOut = !!(err as { killed?: boolean } | null)?.killed;
      done({
        stdout: stdout.toString(),
        stderr: timedOut ? `git ${args[0]} took longer than ${timeout / 1000}s and was stopped` : stderr.toString(),
        code: err ? Number((err as { code?: unknown }).code ?? 1) || 1 : 0,
      });
    });
  });
}

async function ok(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new GitError(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`, r.stderr);
  return r.stdout.trim();
}

/** `checkout-web`: lowercase words joined by dashes, at most `max` long. */
export function slug(text: string, max = 30): string {
  const s = text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return s || 'work';
}

/** A branch name a person may pick as a base: no option-like or otherwise odd input reaches git. */
const SAFE_REF = /^[A-Za-z0-9][\w./-]*$/;

export interface Branch {
  name: string;
  remote: boolean;
}

export interface WorktreeStats {
  /** Commits on the branch not yet on `against`. */
  ahead: number;
  /** `git diff --shortstat`, e.g. "3 files changed, 40 insertions(+), 2 deletions(-)"; empty if none. */
  diffstat: string;
  /** Uncommitted changes. */
  dirty: boolean;
}

export type MergeResult = { ok: true } | { ok: false; conflicts: string[] };

export interface WorktreesOptions {
  store: Store;
  /** Where Kelpie keeps worktrees, e.g. ~/.kelpie/worktrees. Nothing outside it is ever deleted. */
  root: string;
  /** A worktree unused this long (and clean) is swept; its branch stays. */
  idleMs?: number;
  /** At most this many worktrees on disk at once. */
  max?: number;
  now?: () => number;
}

/** Where a worktree's branch was cut; rows from before that was recorded fall back to the base. */
const forkOf = (row: WorktreeRow) => row.forkCommit || row.baseCommit;

/** What a removal is about to take away: work that would be lost is committed first. */
const CHECKPOINT = (what: string) => `kelpie: checkpoint (${what})`;

/**
 * Kelpie's git worktrees: an orchestrator's home (its feature branch) and one per writing
 * agent. Every row is in the database before git touches the disk, git runs one command at a
 * time per repo, and a session's worktree path never changes: harness sessions resume by
 * directory, so a removed worktree comes back at the same path.
 */
export class Worktrees {
  private readonly store: Store;
  readonly root: string;
  private readonly idleMs: number;
  readonly max: number;
  private readonly now: () => number;
  /** One git operation at a time per repo: worktree add/remove and merges share its .git. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly repos = new Map<string, string | undefined>();
  /**
   * Called before a worktree comes off disk, to end any harness process still running in it
   * (idle ones; nothing busy is ever removed). Its next turn starts in the recreated worktree.
   */
  beforeRemove: (row: WorktreeRow) => Promise<void> = async () => {};

  constructor(opts: WorktreesOptions) {
    this.store = opts.store;
    this.root = resolve(opts.root);
    this.idleMs = opts.idleMs ?? 3 * 24 * 60 * 60 * 1000;
    this.max = opts.max ?? 20;
    this.now = opts.now ?? Date.now;
  }

  private locked<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    // The chain never rejects (failures are caught off it), so each operation runs after the last, failed or not.
    const next = (this.locks.get(repo) ?? Promise.resolve()).then(fn);
    this.locks.set(
      repo,
      next.catch(() => {}),
    );
    return next;
  }

  // ── repos and branches ───────────────────────────────────────────────

  /** The main checkout of the repo `cwd` is in, or undefined if it isn't a git repo. */
  async repoOf(cwd: string): Promise<string | undefined> {
    if (this.repos.has(cwd)) return this.repos.get(cwd);
    const r = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    // The common dir is the main checkout's .git, also when cwd is itself a worktree.
    const repo = r.code === 0 && basename(r.stdout.trim()) === '.git' ? dirname(r.stdout.trim()) : undefined;
    this.repos.set(cwd, repo);
    return repo;
  }

  /** Branches a round-up may start from: remote ones first, then local; most recently committed first. */
  async branches(repo: string): Promise<Branch[]> {
    const out = await ok(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/remotes', 'refs/heads']);
    const refs = out.split('\n').filter(Boolean);
    const remote = refs.filter((r) => r.startsWith('refs/remotes/') && !r.endsWith('/HEAD')).map((r) => r.slice('refs/remotes/'.length));
    const local = refs.filter((r) => r.startsWith('refs/heads/') && !r.startsWith('refs/heads/kelpie/')).map((r) => r.slice('refs/heads/'.length));
    return [...remote.map((name) => ({ name, remote: true })), ...local.map((name) => ({ name, remote: false }))];
  }

  /**
   * Pins a base branch: a remote one is fetched first, so the round-up starts from what the
   * remote has now. Returns the commit it points at.
   */
  async pinBase(repo: string, branch: string): Promise<string> {
    if (!SAFE_REF.test(branch) || branch.includes('..')) throw new GitError(`not a branch name: ${branch}`, '');
    const remotes = (await ok(repo, ['remote'])).split('\n').filter(Boolean);
    const remote = remotes.find((r) => branch.startsWith(`${r}/`));
    if (remote) {
      const r = await git(repo, ['fetch', '--quiet', remote, `${branch.slice(remote.length + 1)}`], FETCH_TIMEOUT_MS);
      if (r.code !== 0) throw new GitError(`could not fetch ${branch}: ${r.stderr.trim()}`, r.stderr);
    }
    const r = await git(repo, ['rev-parse', '--verify', '--quiet', `${remote ? `refs/remotes/${branch}` : `refs/heads/${branch}`}^{commit}`]);
    if (r.code !== 0) throw new GitError(`no such branch: ${branch}`, r.stderr);
    return r.stdout.trim();
  }

  // ── layout ───────────────────────────────────────────────────────────

  private dirOf(repo: string, roundUpId: string): string {
    const hash = createHash('sha256').update(repo).digest('hex').slice(0, 8);
    return join(this.root, `${slug(basename(repo), 40)}-${hash}`, roundUpId.slice(0, 8));
  }

  homePath(repo: string, roundUpId: string): string {
    return join(this.dirOf(repo, roundUpId), 'home');
  }

  agentPath(repo: string, roundUpId: string, agentId: string): string {
    return join(this.dirOf(repo, roundUpId), agentId.slice(0, 8));
  }

  /** Flat names: git can't hold both `kelpie/x` and `kelpie/x/y`. */
  homeBranch(title: string, roundUpId: string): string {
    return `kelpie/${slug(title)}-${roundUpId.slice(0, 6)}`;
  }

  agentBranch(home: string, title: string, agentId: string): string {
    return `${home}--${slug(title, 24)}-${agentId.slice(0, 6)}`;
  }

  // ── making and keeping ───────────────────────────────────────────────

  /** The round-up's home worktree, made from its pinned base the first time it is needed. */
  async ensureHome(roundUp: { id: string; title: string; baseBranch: string; baseCommit: string }, repo: string): Promise<WorktreeRow> {
    const existing = this.store.worktreeOf(roundUp.id);
    if (existing) return this.ensure(existing);
    const row = this.store.createWorktree({
      roundUpId: roundUp.id,
      sessionId: roundUp.id,
      kind: 'home',
      repoRoot: repo,
      path: this.homePath(repo, roundUp.id),
      branch: this.homeBranch(roundUp.title || 'round-up', roundUp.id),
      parentBranch: roundUp.baseBranch,
      baseBranch: roundUp.baseBranch,
      baseCommit: roundUp.baseCommit,
      forkCommit: roundUp.baseCommit,
      deliver: null,
    });
    return this.add(row, roundUp.baseCommit);
  }

  /** A writing agent's own worktree, cut from home's current tip so it sees everything mustered so far. */
  async createAgent(agent: { id: string; title: string }, home: WorktreeRow, deliver: 'muster' | 'standalone'): Promise<WorktreeRow> {
    const fork = await ok(home.repoRoot, ['rev-parse', '--verify', `refs/heads/${home.branch}^{commit}`]);
    const row = this.store.createWorktree({
      roundUpId: home.roundUpId,
      sessionId: agent.id,
      kind: 'agent',
      repoRoot: home.repoRoot,
      path: this.agentPath(home.repoRoot, home.roundUpId, agent.id),
      branch: this.agentBranch(home.branch, agent.title, agent.id),
      parentBranch: home.branch,
      baseBranch: home.baseBranch,
      baseCommit: home.baseCommit,
      forkCommit: fork,
      deliver,
    });
    return this.add(row, home.branch);
  }

  /** `git worktree add` for a row recorded as `creating`; the branch is made from `from` unless it exists. */
  private add(row: WorktreeRow, from: string): Promise<WorktreeRow> {
    return this.locked(row.repoRoot, () => this.addNow(row, from));
  }

  /** `add`, for a caller already holding the repo's lock. */
  private async addNow(row: WorktreeRow, from: string): Promise<WorktreeRow> {
    mkdirSync(dirname(row.path), { recursive: true });
    // A stale registration (its directory deleted by hand) would block the path.
    await git(row.repoRoot, ['worktree', 'prune']);
    const exists = (await git(row.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${row.branch}`])).code === 0;
    // A branch made anew (first time, or after its work was mustered and it was deleted) forks from `from` now.
    const fork = exists ? forkOf(row) : await ok(row.repoRoot, ['rev-parse', '--verify', `${from}^{commit}`]);
    await ok(row.repoRoot, exists ? ['worktree', 'add', row.path, row.branch] : ['worktree', 'add', '-b', row.branch, row.path, fork]);
    return this.store.updateWorktree(row.id, { state: 'active', lastUsedAt: this.now(), removedAt: null, forkCommit: fork })!;
  }

  /**
   * Makes sure a worktree is on disk, at its one path. A swept one comes back on its branch; a
   * mustered one (its branch merged and deleted) comes back on a new branch of the same name,
   * cut from its parent, for new work.
   */
  ensure(row: WorktreeRow): Promise<WorktreeRow> {
    // Under the repo's lock, so a removal already under way finishes first and is then undone.
    return this.locked(row.repoRoot, async () => {
      const now = this.store.worktreeOf(row.sessionId) ?? row;
      if ((now.state === 'active' || now.state === 'creating') && existsSync(now.path)) return this.touch(now);
      return this.addNow(now, now.parentBranch);
    });
  }

  touch(row: WorktreeRow): WorktreeRow {
    return this.store.updateWorktree(row.id, { lastUsedAt: this.now() }) ?? row;
  }

  async dirty(path: string): Promise<boolean> {
    return (await ok(path, ['status', '--porcelain'])).length > 0;
  }

  /** Commits whatever is uncommitted, so nothing a later merge or removal relies on is lost. True if it did. */
  async checkpoint(row: WorktreeRow, what: string): Promise<boolean> {
    if (!existsSync(row.path)) return false;
    return this.locked(row.repoRoot, async () => {
      if (!(await this.dirty(row.path))) return false;
      await ok(row.path, ['add', '-A']);
      // No hooks: a checkpoint must not be refused by a linter. Kelpie's name only if git has none.
      await ok(row.path, [...(await this.identity(row.path)), 'commit', '--quiet', '--no-verify', '-m', CHECKPOINT(what)]);
      return true;
    });
  }

  private async identity(cwd: string): Promise<string[]> {
    const email = await git(cwd, ['config', 'user.email']);
    return email.code === 0 && email.stdout.trim() ? [] : ['-c', 'user.name=Kelpie', '-c', 'user.email=kelpie@localhost'];
  }

  // ── merging ──────────────────────────────────────────────────────────

  /** Merges `branch` into home with a merge commit; on conflict the merge is undone and the files named. */
  merge(home: WorktreeRow, branch: string, message: string): Promise<MergeResult> {
    return this.locked(home.repoRoot, async () => {
      if (await this.dirty(home.path)) return { ok: false, conflicts: ['(home has uncommitted changes)'] };
      const r = await git(home.path, [...(await this.identity(home.path)), 'merge', '--no-ff', '--no-verify', '-m', message, branch]);
      if (r.code === 0) return { ok: true };
      const conflicts = (await git(home.path, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
      await git(home.path, ['merge', '--abort']);
      return { ok: false, conflicts: conflicts.length ? conflicts : [r.stderr.trim() || 'merge failed'] };
    });
  }

  /** Commits on the worktree's branch since it was cut: its own work. */
  async ownCommits(row: WorktreeRow): Promise<number> {
    const r = await git(row.repoRoot, ['rev-list', '--count', `${forkOf(row)}..refs/heads/${row.branch}`]);
    return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
  }

  /** An agent's work is in home: it has commits of its own, and home has all of them. */
  async musteredIn(row: WorktreeRow, home: WorktreeRow): Promise<boolean> {
    return (await this.ownCommits(row)) > 0 && (await this.isMerged(row.repoRoot, row.branch, home.branch));
  }

  /** Whether everything on `branch` is in `into` (so it can go). */
  async isMerged(repo: string, branch: string, into: string): Promise<boolean> {
    return (await git(repo, ['merge-base', '--is-ancestor', branch, into])).code === 0;
  }

  async stats(row: WorktreeRow, against: string): Promise<WorktreeStats> {
    const ahead = await git(row.repoRoot, ['rev-list', '--count', `${against}..${row.branch}`]);
    const diffstat = await git(row.repoRoot, ['diff', '--shortstat', `${against}...${row.branch}`]);
    return {
      ahead: Number(ahead.stdout.trim()) || 0,
      diffstat: diffstat.stdout.trim(),
      dirty: existsSync(row.path) ? await this.dirty(row.path) : false,
    };
  }

  // ── cleaning up ──────────────────────────────────────────────────────

  /**
   * Takes the worktree off disk (its row stays, so it can come back at the same path). With
   * `unless`, it is checked again under the repo's lock, and the worktree stays if it now says
   * so (someone started working there meanwhile): then the result is undefined.
   */
  async remove(row: WorktreeRow, state: 'removed' | 'mustered' = 'removed', deleteBranch = false, unless?: (row: WorktreeRow) => boolean): Promise<WorktreeRow | undefined> {
    if (unless?.(row)) return undefined;
    await this.beforeRemove(row);
    return this.locked(row.repoRoot, async () => {
      if (unless?.(row)) return undefined;
      if (existsSync(row.path)) {
        const r = await git(row.repoRoot, ['worktree', 'remove', '--force', row.path]);
        // Not registered with git (half made): it is Kelpie's own directory, so it can go.
        if (r.code !== 0 && this.inRoot(row.path)) rmSync(row.path, { recursive: true, force: true });
      }
      await git(row.repoRoot, ['worktree', 'prune']);
      if (deleteBranch) await git(row.repoRoot, ['branch', '-D', row.branch]);
      return this.store.updateWorktree(row.id, { state, removedAt: this.now() })!;
    });
  }

  /**
   * An agent's branch is in home: its worktree and branch go. If the agent works again, both
   * come back (from home's tip) at the same path.
   */
  async mustered(row: WorktreeRow, home: WorktreeRow): Promise<WorktreeRow> {
    // Anything left uncommitted is kept on the branch; then the branch only goes if home has all of it.
    await this.checkpoint(row, 'before muster cleanup');
    return (await this.remove(row, 'mustered', await this.isMerged(row.repoRoot, row.branch, home.branch)))!;
  }

  /**
   * One agent is being deleted: whatever it left is committed, its worktree comes off disk, and
   * its branch goes only if home has all of it. Returns the branch if it was kept.
   */
  async removeAgent(sessionId: string): Promise<string | undefined> {
    const row = this.store.worktreeOf(sessionId);
    if (!row || row.kind !== 'agent') return undefined;
    const home = this.store.worktreeOf(row.roundUpId);
    await this.checkpoint(row, 'agent deleted');
    const branchExists = (await git(row.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${row.branch}`])).code === 0;
    const merged = branchExists && !!home && (await this.isMerged(row.repoRoot, row.branch, home.branch));
    if (row.state === 'creating' || row.state === 'active') await this.remove(row, 'removed', merged);
    else if (merged) await git(row.repoRoot, ['branch', '-D', row.branch]);
    return branchExists && !merged ? row.branch : undefined;
  }

  /**
   * Removes worktrees nobody has used for a while, oldest first, but only clean ones: a dirty
   * worktree holds work. `inUse` says whether any session is working in one right now. With
   * `force`, age doesn't matter (making room under the cap).
   */
  async sweep(inUse: (row: WorktreeRow) => boolean, opts: { force?: boolean; limit?: number } = {}): Promise<number> {
    let removed = 0;
    for (const row of this.store.liveWorktrees()) {
      if (opts.limit !== undefined && removed >= opts.limit) break;
      if (inUse(row) || row.state !== 'active') continue;
      if (!opts.force && this.now() - row.lastUsedAt < this.idleMs) continue;
      if (existsSync(row.path) && (await this.dirty(row.path))) continue;
      // Checked again under the lock: work may have started in it while we looked.
      if (await this.remove(row, 'removed', false, inUse)) removed++;
    }
    return removed;
  }

  /**
   * Makes room for `need` more worktrees under the cap, removing the oldest clean idle ones
   * (never one `keep` names, e.g. the feature branch the new ones are cut from). False if it can't.
   */
  async makeRoom(inUse: (row: WorktreeRow) => boolean, need = 1, keep: (row: WorktreeRow) => boolean = () => false): Promise<boolean> {
    const over = () => this.store.liveWorktrees().length + need - this.max;
    if (over() <= 0) return true;
    await this.sweep((row) => inUse(row) || keep(row), { force: true, limit: over() });
    return over() <= 0;
  }

  /**
   * A round-up is going: everything is committed, its worktrees come off disk, and branches go
   * only if their work is merged (into home, or for home into its base). Returns branches kept.
   */
  async removeRoundUp(roundUpId: string): Promise<string[]> {
    const rows = this.store.worktreesOf(roundUpId);
    const home = rows.find((r) => r.kind === 'home');
    const kept: string[] = [];
    for (const row of [...rows.filter((r) => r.kind === 'agent'), ...(home ? [home] : [])]) {
      await this.checkpoint(row, 'round-up deleted');
      const into = row.kind === 'agent' && home ? home.branch : row.baseCommit;
      const merged = await this.isMerged(row.repoRoot, row.branch, into);
      const branchExists = (await git(row.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${row.branch}`])).code === 0;
      if (row.state !== 'removed' && row.state !== 'mustered') await this.remove(row, 'removed', merged);
      else if (merged) await git(row.repoRoot, ['branch', '-D', row.branch]);
      if (branchExists && !merged) kept.push(row.branch);
    }
    // Its folder under the root, and the repo's, once nothing is left in them.
    if (rows[0]) for (const dir of [this.dirOf(rows[0].repoRoot, roundUpId), dirname(this.dirOf(rows[0].repoRoot, roundUpId))]) this.removeIfEmpty(dir);
    return kept;
  }

  private removeIfEmpty(dir: string): void {
    if (this.inRoot(dir) && existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  }

  /**
   * After a daemon start: the database and the disk agree again. Half-made worktrees are
   * finished or dropped, missing ones marked removed, strays under Kelpie's root deleted, and a
   * merge left half-done in a home is aborted unless its Muster agent will resume it.
   */
  async reconcile(resuming: (row: WorktreeRow) => boolean): Promise<void> {
    const rows = this.store.allWorktrees();
    for (const repo of new Set(rows.map((r) => r.repoRoot))) if (existsSync(repo)) await git(repo, ['worktree', 'prune']);
    for (const row of rows) {
      if (row.state !== 'creating' && row.state !== 'active') continue;
      if (!existsSync(row.path)) {
        this.store.updateWorktree(row.id, { state: 'removed', removedAt: this.now() });
        continue;
      }
      if (row.state === 'creating') this.store.updateWorktree(row.id, { state: 'active' });
      if (row.kind === 'home' && !resuming(row) && (await git(row.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0) {
        await git(row.path, ['merge', '--abort']);
      }
    }
    // Directories under the root that no live row owns: left by a crash, or by hand.
    const owned = new Set(this.store.liveWorktrees().map((r) => r.path));
    for (const path of this.leaves()) if (!owned.has(path)) await this.discardStray(path);
    for (const repo of new Set(rows.map((r) => r.repoRoot))) if (existsSync(repo)) await git(repo, ['worktree', 'prune']);
  }

  /**
   * A worktree directory no row owns. If it is still a git worktree, whatever is uncommitted is
   * committed to its branch first (the branch stays), so nothing in it is lost; then it goes.
   */
  private async discardStray(path: string): Promise<void> {
    const common = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const top = await git(path, ['rev-parse', '--show-toplevel']);
    // Only a worktree rooted at this very directory; anything else is just a leftover folder.
    if (common.code === 0 && top.code === 0 && realpathSync(top.stdout.trim()) === realpathSync(path) && basename(common.stdout.trim()) === '.git') {
      const repo = dirname(common.stdout.trim());
      if ((await git(path, ['status', '--porcelain'])).stdout.trim()) {
        await git(path, ['add', '-A']);
        await git(path, [...(await this.identity(path)), 'commit', '--quiet', '--no-verify', '-m', CHECKPOINT('stray worktree')]);
      }
      await git(repo, ['worktree', 'remove', '--force', path]);
    }
    if (this.inRoot(path) && existsSync(path)) rmSync(path, { recursive: true, force: true });
  }

  /** `<root>/<repo>/<round-up>/<worktree>` directories on disk. */
  private leaves(): string[] {
    if (!existsSync(this.root)) return [];
    const dirs = (p: string) => readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(p, d.name));
    return dirs(this.root).flatMap((repo) => dirs(repo).flatMap((roundUp) => dirs(roundUp)));
  }

  private inRoot(path: string): boolean {
    const rel = relative(this.root, resolve(path));
    return !!rel && !rel.startsWith('..') && !rel.startsWith(sep);
  }
}
