import { existsSync } from 'node:fs';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parsePatch } from 'diff';
import { LRUCache } from 'lru-cache';
import type { DeliveryRow, Store } from '@kelpie/store';
import { baseCommit, operationIn, ownBase, runGit, type Operation } from '../worktrees.js';
import type { AgentRef, ChangedFile, Changes as ChangesView, Round, Side } from './types.js';

/** A whole feature's patch may be this big before every file is sent as too large. */
const PATCH_BUFFER = 64 * 1024 * 1024;
/** One file's patch is left out (load it alone) past this many changed lines or bytes. */
const FILE_LINES = 3000;
const FILE_BYTES = 400 * 1024;
/** Patches in one response, all told. */
const BUDGET = 8 * 1024 * 1024;
/** A file loaded on its own. */
const FILE_LIMIT = 5 * 1024 * 1024;
const UNTRACKED_MAX = 100;
/** Lines of the hunk kept before a commented line, in its thread's excerpt. */
const EXCERPT_BEFORE = 6;
/** Paths exactly as they are (not octal-quoted), whatever the person's config. */
const RAW_PATHS = ['-c', 'core.quotePath=false'];
const DIFF = [...RAW_PATHS, 'diff', '--no-color', '--no-ext-diff', '-M'];

/** One diff a Changes response is about: which commits (or the worktree) it compares. */
export interface View {
  scope: 'feature' | 'agent';
  sessionId: string;
  roundUpId: string;
  repo: string;
  /** What it is diffed against, as named (see `OwnWork.base`): the identity its threads and rounds keep. */
  baseSha: string;
  /** That base's commit, for git. */
  base: string;
  headSha: string;
  /**
   * Work under way: the worktree's files are the new side, uncommitted work included. An agent's
   * worktree, or the feature checkout while it holds uncommitted work (the orchestrator's own edits).
   */
  workdir?: string;
  dirty?: boolean;
  /** A merge or rebase under way in its worktree: the view is of its branch's commits instead. */
  inProgress?: Operation;
  branch: string;
  baseRef: string;
  checkoutPath?: string;
  rounds?: Round[];
  round?: number;
  /** Agent scope: whose it is. */
  agent?: AgentRef;
}

/** A file in a diff, before it is put down to agents. */
type RawFile = Omit<ChangedFile, 'agents'>;

/** A thread's anchor, as far as finding it again goes. */
export interface Anchored {
  view: 'feature' | 'agent';
  roundUpId: string;
  viewSessionId: string | null;
  path: string;
  side: Side;
  line: number;
  lineText: string;
  /** The commits it was made on: they say which of an agent's rounds it belongs to. */
  commitSha: string;
  baseSha: string;
}

/**
 * Which of an agent's rounds: by number, or the one these commits identify (`commitSha` its head,
 * else `baseSha` its fork, which stays the same while the round's work goes on and is mustered).
 * Nothing matching, or nothing given, is the default round.
 */
export type RoundPick = number | { commitSha?: string; baseSha?: string };

export type AnchorResult =
  | { ok: true; view: View; diffHunk: string; owner: AgentRef | null }
  | { ok: false; reason: 'none' | 'file' | 'stale' };

/** A round asked for that the agent never had. */
export class NoSuchRound extends Error {}

const lineCount = (patch: string) => {
  const [p] = parsePatch(patch);
  let additions = 0;
  let deletions = 0;
  for (const h of p?.hunks ?? []) for (const l of h.lines) l[0] === '+' ? additions++ : l[0] === '-' && deletions++;
  return { additions, deletions };
};

/** `git diff -z --numstat` entries; a rename's paths come as their own fields. */
function numstat(out: string): { path: string; oldPath?: string; binary: boolean; additions: number; deletions: number }[] {
  const t = out.split('\0');
  const files = [];
  for (let i = 0; i < t.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([^]*)$/.exec(t[i]!);
    if (!m) continue;
    let path = m[3]!;
    let oldPath: string | undefined;
    if (path === '') {
      oldPath = t[++i];
      path = t[++i] ?? '';
    }
    files.push({ path, ...(oldPath !== undefined ? { oldPath } : {}), binary: m[1] === '-', additions: Number(m[1]) || 0, deletions: Number(m[2]) || 0 });
  }
  return files;
}

/** `git diff -z --name-status`: each new path's status. */
function nameStatus(out: string): Map<string, ChangedFile['status']> {
  const t = out.split('\0');
  const status = new Map<string, ChangedFile['status']>();
  for (let i = 0; i < t.length; i++) {
    const s = t[i]!;
    if (!/^[ACDMRTUX]\d*$/.test(s)) continue;
    const two = s[0] === 'R' || s[0] === 'C';
    if (two) i++;
    const path = t[++i];
    if (path !== undefined) status.set(path, s[0] === 'A' || s[0] === 'C' ? 'added' : s[0] === 'D' ? 'deleted' : s[0] === 'R' ? 'renamed' : 'modified');
  }
  return status;
}

/** A patch cut into its files' `diff --git` chunks, in order. */
const chunks = (patch: string) => patch.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));

/** The new path a chunk is for, from its headers (used only when chunks and numstat disagree). */
function chunkPath(chunk: string): string | undefined {
  return /^\+\+\+ b\/(.*)$/m.exec(chunk)?.[1] ?? /^rename to (.*)$/m.exec(chunk)?.[1] ?? /^--- a\/(.*)$/m.exec(chunk)?.[1] ?? /^diff --git a\/.* b\/(.*)$/m.exec(chunk)?.[1];
}

/**
 * The hunk header, up to six lines before the line and the line itself, from a file's patch: what a
 * thread shows of the code it is on. Undefined if the line is outside every hunk.
 */
export function excerpt(patch: string, side: Side, line: number): string | undefined {
  const [p] = parsePatch(patch);
  for (const h of p?.hunks ?? []) {
    let oldLine = h.oldStart;
    let newLine = h.newStart;
    const seen: string[] = [];
    for (const l of h.lines) {
      const c = l[0];
      if (c === '\\') continue;
      const hit = side === 'deletions' ? c !== '+' && oldLine === line : c !== '-' && newLine === line;
      if (hit) return [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...seen.slice(-EXCERPT_BEFORE), l].join('\n');
      seen.push(l);
      if (c !== '+') oldLine++;
      if (c !== '-') newLine++;
    }
  }
  return undefined;
}

/** Where a line of text sits in `content` now: at `line` still, or the one place it moved to. */
export function findLine(content: string, line: number, text: string): number | undefined {
  const lines = content.split('\n').map((l) => l.replace(/\r$/, ''));
  const want = text.replace(/\r$/, '');
  if (lines[line - 1] === want) return line;
  const trimmed = want.trim();
  if (!trimmed) return undefined;
  let found: number | undefined;
  for (const [i, l] of lines.entries()) {
    if (l.trim() !== trimmed) continue;
    if (found !== undefined) return undefined;
    found = i + 1;
  }
  return found;
}

/** A path from a request that stays inside the tree it names. */
const safePath = (path: string) => !!path && !isAbsolute(path) && !path.split(/[\\/]/).includes('..') && !path.includes('\0');

/**
 * What changed in a round-up: the feature branch's own work, or one writer's (from `ownBase`), as git
 * sees it. Everything here only reads git, but for the objects of the merge bases it makes (see
 * `baseCommit`), which change no ref; so it takes no locks.
 */
export class Changes {
  /** Committed diffs, by repo and commits (which never change). */
  private readonly diffs = new LRUCache<string, RawFile[] | 'overflow'>({
    max: 20,
    maxSize: 128 * 1024 * 1024,
    sizeCalculation: (files) => (files === 'overflow' ? 1 : Math.max(1, files.reduce((n, f) => n + (f.patch?.length ?? 0) + f.path.length, 0))),
  });
  /** The files each delivery changed, by its commits. */
  private readonly touched = new LRUCache<string, Set<string>>({ max: 500 });
  /** The commits each delivery brought, by its commits. */
  private readonly commits = new LRUCache<string, Set<string>>({ max: 500 });
  /** File contents, by commit and path; null if it isn't there. */
  private readonly contents = new LRUCache<string, { text: string | null }>({
    max: 2000,
    maxSize: 64 * 1024 * 1024,
    sizeCalculation: (c) => Math.max(1, c.text?.length ?? 1),
  });

  constructor(private readonly store: Store) {}

  // ── views ────────────────────────────────────────────────────────────

  /**
   * The diff a session's Changes show: a round-up's feature branch, or an agent's round (by default
   * its work under way, else its latest delivery). 'none' when there is nothing to diff; undefined
   * for an unknown session. `round` picks another of an agent's rounds (see RoundPick).
   */
  async view(sessionId: string, round?: RoundPick): Promise<View | 'none' | undefined> {
    const session = this.store.getSession(sessionId);
    if (!session) return undefined;
    if (!session.parentId) {
      const home = this.store.worktreeOf(session.id);
      if (!home || home.kind !== 'home') return 'none';
      const head = await this.revParse(home.repoRoot, `refs/heads/${home.branch}`);
      if (!head) return 'none';
      const baseSha = await ownBase(home, head);
      // The orchestrator's edits under way (it works there itself at solo and balanced) show until
      // Kelpie commits them; never half of Muster's merge.
      const onDisk = (home.state === 'active' || home.state === 'creating') && existsSync(home.path);
      const dirty = onDisk && !(await operationIn(home.path)) && (await runGit(home.path, ['status', '--porcelain'])).stdout.trim().length > 0;
      return {
        scope: 'feature',
        sessionId,
        roundUpId: session.id,
        repo: home.repoRoot,
        baseSha,
        base: await baseCommit(home.repoRoot, baseSha),
        headSha: head,
        branch: home.branch,
        baseRef: home.baseBranch,
        ...(existsSync(home.path) ? { checkoutPath: home.path } : {}),
        ...(dirty ? { workdir: home.path, dirty } : {}),
      };
    }
    if (session.kind === 'muster' || !session.writes) return 'none';
    const row = this.store.worktreeOf(session.id);
    if (!row || row.kind !== 'agent') return 'none';
    const delivered = this.store.deliveriesOf(session.parentId).filter((d) => d.sessionId === session.id);
    const rounds: Round[] = delivered.map((d, i) => ({ index: i + 1, state: 'mustered', baseSha: d.forkCommit, headSha: d.tipCommit }));
    let workdir: string | undefined;
    let inProgress: Operation | undefined;
    const onDisk = (row.state === 'active' || row.state === 'creating') && existsSync(row.path);
    if (onDisk) {
      // Half a merge or rebase isn't its work (yet): what its branch has committed is.
      inProgress = await operationIn(row.path);
      const head = inProgress ? await this.revParse(row.repoRoot, `refs/heads/${row.branch}`) : await this.revParse(row.path, 'HEAD');
      if (head) {
        rounds.push({ index: rounds.length + 1, state: 'active', baseSha: await ownBase(row, head), headSha: head });
        if (!inProgress) workdir = row.path;
      }
    } else if (row.state === 'removed') {
      // Swept off disk, its work not mustered: its branch is the work.
      const tip = await this.revParse(row.repoRoot, `refs/heads/${row.branch}`);
      if (tip) rounds.push({ index: rounds.length + 1, state: 'active', baseSha: await ownBase(row, tip), headSha: tip });
    }
    if (!rounds.length) return 'none';
    const active = rounds.find((r) => r.state === 'active');
    const fallback = active ?? rounds.at(-1)!;
    let picked: Round | undefined;
    if (typeof round === 'number') {
      picked = rounds.find((r) => r.index === round);
      if (!picked) throw new NoSuchRound(`no round ${round}: this agent has ${rounds.length}`);
    } else {
      picked = (round?.commitSha && rounds.find((r) => r.headSha === round.commitSha)) || (round?.baseSha && rounds.find((r) => r.baseSha === round.baseSha)) || fallback;
    }
    const live = picked.state === 'active' && workdir !== undefined;
    const dirty = live ? (await runGit(workdir!, ['status', '--porcelain'])).stdout.trim().length > 0 : false;
    return {
      scope: 'agent',
      sessionId,
      roundUpId: session.parentId,
      repo: row.repoRoot,
      baseSha: picked.baseSha,
      base: await baseCommit(row.repoRoot, picked.baseSha),
      headSha: picked.headSha,
      ...(live ? { workdir: workdir!, dirty, checkoutPath: workdir! } : {}),
      ...(picked.state === 'active' && inProgress ? { inProgress, checkoutPath: row.path } : {}),
      branch: row.branch,
      baseRef: row.parentBranch,
      rounds,
      round: picked.index,
      agent: { id: session.id, title: session.title, harness: session.harness },
    };
  }

  /** A session's Changes. Without `patches`, just the file list (for a badge). */
  async of(sessionId: string, opts: { patches?: boolean; round?: number } = {}): Promise<ChangesView | undefined> {
    const session = this.store.getSession(sessionId);
    const view = await this.view(sessionId, opts.round);
    if (!view || !session) return undefined;
    if (view === 'none') {
      return { scope: session.parentId ? 'agent' : 'feature', sessionId, roundUpId: session.parentId ?? session.id, state: 'none', stats: { files: 0, additions: 0, deletions: 0 }, files: [] };
    }
    const raw = await this.diff(view);
    const files = await this.attribute(view, raw === 'overflow' ? [] : raw);
    let budget = BUDGET;
    const out = files.map((f) => {
      if (!f.patch) return f;
      if (opts.patches === false) {
        const { patch: _, ...rest } = f;
        return rest;
      }
      budget -= f.patch.length;
      if (budget >= 0) return f;
      const { patch: _, ...rest } = f;
      return { ...rest, tooLarge: true };
    });
    const musteredFrom = view.scope === 'feature' ? this.distinct(this.store.deliveriesOf(view.roundUpId).map((d) => this.refOf(d))) : undefined;
    return {
      scope: view.scope,
      sessionId,
      roundUpId: view.roundUpId,
      state: 'ready',
      branch: view.branch,
      baseRef: view.baseRef,
      baseSha: view.baseSha,
      headSha: view.headSha,
      ...(view.scope === 'agent' || view.dirty ? { dirty: !!view.dirty } : {}),
      ...(view.inProgress ? { inProgress: view.inProgress } : {}),
      ...(view.checkoutPath ? { checkoutPath: view.checkoutPath } : {}),
      ...(musteredFrom ? { musteredFrom } : {}),
      ...(view.rounds ? { rounds: view.rounds, round: view.round! } : {}),
      stats: { files: out.length, additions: out.reduce((n, f) => n + f.additions, 0), deletions: out.reduce((n, f) => n + f.deletions, 0) },
      files: out,
    };
  }

  /** One file of a session's Changes, with its patch unless even that is too big. Null if it didn't change. */
  async file(sessionId: string, path: string, round?: number): Promise<ChangedFile | null | undefined> {
    const view = await this.view(sessionId, round);
    if (!view) return undefined;
    if (view === 'none') return null;
    const raw = await this.diff(view);
    const listed = raw === 'overflow' ? await this.list(view) : raw;
    const file = listed.find((f) => f.path === path);
    if (!file) return null;
    const [attributed] = await this.attribute(view, [file]);
    if (file.binary || (file.patch && !file.tooLarge)) return attributed!;
    const patch = await this.patchOf(view, file);
    return patch === undefined ? { ...attributed!, tooLarge: true } : { ...attributed!, patch, tooLarge: false };
  }

  // ── anchors and threads ──────────────────────────────────────────────

  /**
   * Checks a new comment's anchor against the diff it was made on (for an agent, the round whose head
   * is `commitSha`; else its default round), and works out what its thread keeps: the excerpt, and
   * whose change the line is. `stale` if the line no longer says `lineText`.
   */
  async anchor(viewSessionId: string, a: { path: string; side: Side; line: number; lineText: string; commitSha?: string }): Promise<AnchorResult> {
    const view = await this.view(viewSessionId, { ...(a.commitSha ? { commitSha: a.commitSha } : {}) });
    if (!view || view === 'none') return { ok: false, reason: 'none' };
    if (!safePath(a.path)) return { ok: false, reason: 'file' };
    const raw = await this.diff(view);
    const files = raw === 'overflow' ? await this.list(view) : raw;
    const file = files.find((f) => f.path === a.path);
    if (!file || file.binary) return { ok: false, reason: 'file' };
    const content = await this.content(view, a.side, file.path, file.oldPath);
    if (content === null) return { ok: false, reason: 'stale' };
    const lines = content.split('\n');
    if ((lines[a.line - 1] ?? null)?.replace(/\r$/, '') !== a.lineText.replace(/\r$/, '')) return { ok: false, reason: 'stale' };
    const patch = file.patch && !file.tooLarge ? file.patch : await this.patchOf(view, file);
    const diffHunk = (patch && excerpt(patch, a.side, a.line)) ?? ` ${a.lineText}`;
    const [attributed] = await this.attribute(view, [file]);
    return { ok: true, view, diffHunk, owner: await this.owner(view, attributed!, a.side, a.line) };
  }

  /**
   * Finds threads in the diffs as they are now: the feature's, or for an agent's thread the round it
   * was made on. Returns a function giving a thread's current line, or undefined when it is outdated;
   * views and file contents are read once for all the threads asked about.
   */
  locator(): (t: Anchored) => Promise<number | undefined> {
    const views = new Map<string, Promise<View | 'none' | undefined>>();
    const files = new Map<string, Promise<string | null>>();
    return async (t) => {
      const id = t.view === 'feature' ? t.roundUpId : t.viewSessionId;
      if (!id) return undefined;
      const which = t.view === 'agent' ? `${id}\0${t.commitSha}\0${t.baseSha}` : id;
      if (!views.has(which)) views.set(which, this.view(id, t.view === 'agent' ? { commitSha: t.commitSha, baseSha: t.baseSha } : undefined).catch(() => undefined));
      const view = await views.get(which);
      if (!view || view === 'none') return undefined;
      const key = `${view.sessionId}\0${view.baseSha}\0${view.headSha}\0${t.side}\0${t.path}`;
      if (!files.has(key)) files.set(key, this.threadContent(view, t.side, t.path).catch(() => null));
      const content = await files.get(key);
      return content === null || content === undefined ? undefined : findLine(content, t.line, t.lineText);
    };
  }

  // ── git ──────────────────────────────────────────────────────────────

  private async revParse(cwd: string, ref: string): Promise<string | undefined> {
    const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  /** The view's files with their patches (those not too large), or 'overflow' if the whole patch is too big to read. */
  private async diff(view: View): Promise<RawFile[] | 'overflow'> {
    if (view.workdir && view.dirty) return this.workingDiff(view.workdir, view.base);
    const key = `${view.repo}\0${view.base}..${view.headSha}`;
    const cached = this.diffs.get(key);
    if (cached) return cached;
    const range = [view.base, view.headSha];
    const [stats, status, patch] = await Promise.all([
      runGit(view.repo, [...DIFF, '-z', '--numstat', ...range]),
      runGit(view.repo, [...DIFF, '-z', '--name-status', ...range]),
      runGit(view.repo, [...DIFF, '-U3', ...range], { maxBuffer: PATCH_BUFFER }),
    ]);
    if (stats.code !== 0) throw new Error(`git diff failed: ${stats.stderr.trim()}`);
    const files = patch.overflow ? 'overflow' : this.assemble(stats.stdout, status.stdout, patch.stdout);
    this.diffs.set(key, files);
    return files;
  }

  /** Every file of a view with its counts but no patch: when the whole patch was too big. */
  private async list(view: View): Promise<RawFile[]> {
    const where = view.workdir && view.dirty ? { cwd: view.workdir, range: [view.base] } : { cwd: view.repo, range: [view.base, view.headSha] };
    const [stats, status] = await Promise.all([
      runGit(where.cwd, [...DIFF, '-z', '--numstat', ...where.range]),
      runGit(where.cwd, [...DIFF, '-z', '--name-status', ...where.range]),
    ]);
    const kinds = nameStatus(status.stdout);
    return numstat(stats.stdout).map((f) => ({ ...f, status: kinds.get(f.path) ?? 'modified', tooLarge: !f.binary }));
  }

  /** An agent's worktree against where its branch was cut: commits, uncommitted and untracked files. */
  private async workingDiff(cwd: string, fork: string): Promise<RawFile[] | 'overflow'> {
    const [stats, status, patch, others] = await Promise.all([
      runGit(cwd, [...DIFF, '-z', '--numstat', fork]),
      runGit(cwd, [...DIFF, '-z', '--name-status', fork]),
      runGit(cwd, [...DIFF, '-U3', fork], { maxBuffer: PATCH_BUFFER }),
      runGit(cwd, [...RAW_PATHS, 'ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    if (stats.code !== 0) throw new Error(`git diff failed: ${stats.stderr.trim()}`);
    if (patch.overflow) return 'overflow';
    const files = this.assemble(stats.stdout, status.stdout, patch.stdout);
    const untracked = others.stdout.split('\0').filter(Boolean).slice(0, UNTRACKED_MAX);
    for (const path of untracked) {
      // Exit code 1 is git saying the two differ.
      const r = await runGit(cwd, [...DIFF, '-U3', '--no-index', '--', '/dev/null', path], { maxBuffer: FILE_LIMIT });
      const binary = /^Binary files /m.test(r.stdout);
      const counts = r.overflow || binary ? { additions: 0, deletions: 0 } : lineCount(r.stdout);
      files.push(this.sized({ path, status: 'added', binary, ...counts }, r.overflow ? undefined : r.stdout));
    }
    return files;
  }

  /** numstat, name-status and the patch of one diff, put together per file. */
  private assemble(stats: string, status: string, patch: string): RawFile[] {
    const kinds = nameStatus(status);
    const entries = numstat(stats);
    const parts = chunks(patch);
    const byPath = parts.length === entries.length ? undefined : new Map(parts.map((c) => [chunkPath(c), c]));
    return entries.map((f, i) => this.sized({ ...f, status: kinds.get(f.path) ?? (f.oldPath ? 'renamed' : 'modified') }, byPath ? byPath.get(f.path) : parts[i]));
  }

  /** A file with its patch, unless that is binary or too large to send with the rest. */
  private sized(f: Omit<RawFile, 'patch' | 'tooLarge'>, patch: string | undefined): RawFile {
    if (f.binary || patch === undefined) return { ...f, ...(f.binary ? {} : { tooLarge: true }) };
    if (f.additions + f.deletions > FILE_LINES || patch.length > FILE_BYTES) return { ...f, tooLarge: true };
    return { ...f, patch };
  }

  /** One file's patch on its own (up to 5 MB); undefined if it is bigger. */
  private async patchOf(view: View, file: RawFile): Promise<string | undefined> {
    const paths = ['--', ...(file.oldPath ? [file.oldPath] : []), file.path];
    let r;
    if (view.workdir && view.dirty) {
      const tracked = await runGit(view.workdir, [...RAW_PATHS, 'ls-files', '--error-unmatch', '--', file.path]);
      r = tracked.code === 0 || file.status !== 'added'
        ? await runGit(view.workdir, [...DIFF, '-U3', view.base, ...paths], { maxBuffer: FILE_LIMIT })
        : await runGit(view.workdir, [...DIFF, '-U3', '--no-index', '--', '/dev/null', file.path], { maxBuffer: FILE_LIMIT });
    } else {
      r = await runGit(view.repo, [...DIFF, '-U3', view.base, view.headSha, ...paths], { maxBuffer: FILE_LIMIT });
    }
    if (r.overflow) return undefined;
    return chunks(r.stdout)[0];
  }

  /** The text of one side of a file: the old side at the base, the new at the head (or in the worktree). */
  private async content(view: View, side: Side, path: string, oldPath?: string): Promise<string | null> {
    if (side === 'deletions') return this.show(view.repo, view.base, oldPath ?? path);
    if (view.workdir) return this.readWorking(view.workdir, path);
    return this.show(view.repo, view.headSha, path);
  }

  /** As `content`, for a thread: a renamed file's old side is found by its new path. */
  private async threadContent(view: View, side: Side, path: string): Promise<string | null> {
    if (side === 'additions') return this.content(view, side, path);
    const raw = await this.diff(view);
    const files = raw === 'overflow' ? await this.list(view) : raw;
    return this.content(view, side, path, files.find((f) => f.path === path)?.oldPath);
  }

  private async show(repo: string, sha: string, path: string): Promise<string | null> {
    const key = `${sha}:${path}`;
    const cached = this.contents.get(key);
    if (cached) return cached.text;
    const r = await runGit(repo, ['cat-file', 'blob', key], { maxBuffer: FILE_LIMIT * 4 });
    const text = r.code === 0 ? r.stdout : null;
    this.contents.set(key, { text });
    return text;
  }

  /** A file in a worktree as it is now; a link is its target's path, as git sees it. */
  private async readWorking(dir: string, path: string): Promise<string | null> {
    if (!safePath(path)) return null;
    const full = join(dir, path);
    try {
      const st = await lstat(full);
      if (st.isSymbolicLink()) return await readlink(full);
      if (!st.isFile() || st.size > FILE_LIMIT * 4) return null;
      return await readFile(full, 'utf8');
    } catch {
      return null;
    }
  }

  // ── who changed what ─────────────────────────────────────────────────

  private refOf(d: DeliveryRow): AgentRef {
    const session = d.sessionId ? this.store.getSession(d.sessionId) : undefined;
    return { id: d.sessionId, title: session?.title ?? d.title, harness: session?.harness ?? d.harness };
  }

  private distinct(refs: AgentRef[]): AgentRef[] {
    const seen = new Set<string>();
    return refs.filter((r) => {
      const key = r.id ?? `title:${r.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Each file with who changed it: for the feature, every delivery that touched it; for an agent, the agent. */
  private async attribute(view: View, files: RawFile[]): Promise<ChangedFile[]> {
    if (view.scope === 'agent') return files.map((f) => ({ ...f, agents: [view.agent!] }));
    const deliveries = this.store.deliveriesOf(view.roundUpId);
    const touched = await Promise.all(deliveries.map((d) => this.touchedBy(view.repo, d)));
    return files.map((f) => ({
      ...f,
      agents: this.distinct(deliveries.filter((_, i) => touched[i]!.has(f.path) || (!!f.oldPath && touched[i]!.has(f.oldPath))).map((d) => this.refOf(d))),
    }));
  }

  private async touchedBy(repo: string, d: DeliveryRow): Promise<Set<string>> {
    const key = `${d.forkCommit}..${d.tipCommit}`;
    const cached = this.touched.get(key);
    if (cached) return cached;
    const r = await runGit(repo, [...RAW_PATHS, 'diff', '--name-only', '-M', '-z', await baseCommit(repo, d.forkCommit), d.tipCommit]);
    const set = new Set(r.code === 0 ? r.stdout.split('\0').filter(Boolean) : []);
    if (r.code === 0) this.touched.set(key, set);
    return set;
  }

  private async commitsOf(repo: string, d: DeliveryRow): Promise<Set<string>> {
    const key = `${d.forkCommit}..${d.tipCommit}`;
    const cached = this.commits.get(key);
    if (cached) return cached;
    const r = await runGit(repo, ['rev-list', `${await baseCommit(repo, d.forkCommit)}..${d.tipCommit}`]);
    const set = new Set(r.code === 0 ? r.stdout.split('\n').filter(Boolean) : []);
    if (r.code === 0) this.commits.set(key, set);
    return set;
  }

  /**
   * Whose change one line is. In an agent's view, that agent's. In the feature's, an added line
   * belongs to the newest delivery that brought the commit git blames for it, and a removed one to
   * the file's only agent; anything else (base code, Muster's resolutions) to nobody.
   */
  private async owner(view: View, file: ChangedFile, side: Side, line: number): Promise<AgentRef | null> {
    if (view.scope === 'agent') return view.agent!;
    if (side === 'deletions') return file.agents.length === 1 ? file.agents[0]! : null;
    // Uncommitted lines (the orchestrator's edits under way) blame to no commit, so to nobody.
    const blame = view.workdir
      ? await runGit(view.workdir, ['blame', '--porcelain', '-L', `${line},${line}`, '--', file.path])
      : await runGit(view.repo, ['blame', '--porcelain', '-L', `${line},${line}`, view.headSha, '--', file.path]);
    const commit = blame.code === 0 ? blame.stdout.split(/\s/, 1)[0] : undefined;
    if (!commit) return null;
    const deliveries = this.store.deliveriesOf(view.roundUpId);
    for (const d of [...deliveries].reverse()) if ((await this.commitsOf(view.repo, d)).has(commit)) return this.refOf(d);
    return null;
  }
}
