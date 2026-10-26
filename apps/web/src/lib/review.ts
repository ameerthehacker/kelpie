import type { ChangedFile } from './changes.js';

/** Which side of a diff a line is on. Context lines are anchored as `additions`, by their new line number. */
export type Side = 'additions' | 'deletions';

/** A writer as a review knows it: null for base code, Muster, or an agent since deleted. */
export interface AgentRef {
  id: string | null;
  title: string;
  harness: string;
}

export type Verdict = 'comment' | 'request_changes' | 'approve';

/** What a thread was made on: the round-up's feature diff, or one agent's own. */
export type ReviewView = 'feature' | 'agent';

/** Mirrors the daemon's `ReviewComment`. */
export interface ReviewComment {
  id: string;
  threadId: string;
  author: 'person' | 'orchestrator' | 'agent';
  authorId?: string;
  authorTitle?: string;
  /** The writing agent's harness, while its session is still there. */
  authorHarness?: string;
  body: string;
  /** The person's comments stay pending, and theirs alone to see, until the review is submitted. */
  state: 'pending' | 'published';
  createdAt: number;
  updatedAt: number;
}

/** Mirrors the daemon's `ReviewThread`: comments on one line. */
export interface ReviewThread {
  id: string;
  view: ReviewView;
  viewSessionId?: string;
  /** Whose change the line is. */
  agent?: AgentRef;
  assignedTo?: AgentRef;
  path: string;
  side: Side;
  line: number;
  /** Where the line sits in the current diff; absent when it is outdated. */
  currentLine?: number;
  outdated: boolean;
  commitSha: string;
  lineText: string;
  /** The hunk header and a few lines up to the commented one, as it was. */
  diffHunk: string;
  status: 'pending' | 'open' | 'resolved';
  /** 'person', or the session id of the agent that resolved it. */
  resolvedBy?: string;
  resolvedAt?: number;
  comments: ReviewComment[];
  createdAt: number;
  updatedAt: number;
}

/** Mirrors the daemon's `Review`. */
export interface Review {
  id: string;
  state: 'pending' | 'submitted';
  verdict?: Verdict;
  body: string;
  createdAt: number;
  submittedAt?: number;
  commentIds: string[];
}

/** Mirrors the daemon's `ReviewState`: the person's view of a round-up's review. */
export interface ReviewState {
  roundUpId: string;
  /** The draft review the person's comments go into. */
  pending: Review | null;
  /** Submitted, newest first. */
  reviews: Review[];
  threads: ReviewThread[];
  counts: { open: number; resolved: number; pending: number };
}

/** A new thread's line, as the daemon is asked to pin it. */
export interface Anchor {
  view: ReviewView;
  viewSessionId?: string;
  path: string;
  side: Side;
  line: number;
  commitSha: string;
  lineText: string;
}

/** Which diff a comment is made on, and the commit its lines are read at. */
export interface DiffScope {
  roundUpId: string;
  view: ReviewView;
  /** The agent, for its own diff. */
  viewSessionId?: string;
  /** The commit the diff's lines are read at: see `anchorSha`. */
  commitSha?: string;
}

/** The anchor for a comment on one line of a diff: the one place a new thread's anchor is built. */
export function anchorFor(scope: DiffScope, at: { path: string; side: Side; line: number; lineText: string }): Anchor {
  return {
    view: scope.view,
    ...(scope.view === 'agent' && scope.viewSessionId ? { viewSessionId: scope.viewSessionId } : {}),
    path: at.path,
    side: at.side,
    line: at.line,
    commitSha: scope.commitSha ?? '',
    lineText: at.lineText,
  };
}

export const VERDICT_LABEL: Record<Verdict, string> = { comment: 'Comment', request_changes: 'Request changes', approve: 'Approve' };

/** The threads made on one diff: the feature's, or one agent's. */
export function threadsOn(threads: readonly ReviewThread[], view: ReviewView, sessionId?: string): ReviewThread[] {
  return threads.filter((t) => t.view === view && (view === 'feature' || t.viewSessionId === sessionId));
}

/** An annotation in @pierre/diffs's shape: the threads (and the open comment box) on one line. */
export interface ThreadAnnotation {
  side: Side;
  lineNumber: number;
  metadata: { threadIds: string[]; draft: boolean };
}

/**
 * The inline annotations for one file: a thread sits where its line is now. Threads on the same
 * line share one annotation (the diff has one slot per line), and so does the comment box being
 * written. Outdated threads are not inline; they go above the diff.
 */
export function annotationsFor(threads: readonly ReviewThread[], path: string, draft?: { side: Side; line: number }): ThreadAnnotation[] {
  const byLine = new Map<string, ThreadAnnotation>();
  const at = (side: Side, lineNumber: number) => {
    const key = `${side}:${lineNumber}`;
    let a = byLine.get(key);
    if (!a) byLine.set(key, (a = { side, lineNumber, metadata: { threadIds: [], draft: false } }));
    return a;
  };
  for (const t of threads) {
    if (t.path !== path || t.outdated) continue;
    at(t.side, t.currentLine ?? t.line).metadata.threadIds.push(t.id);
  }
  if (draft) at(draft.side, draft.line).metadata.draft = true;
  return [...byLine.values()].sort((a, b) => a.lineNumber - b.lineNumber || a.side.localeCompare(b.side));
}

/** A hunk's line ranges on both sides, as `@@ -a,b +c,d @@` gives them. */
export interface HunkRange {
  additionStart: number;
  additionCount: number;
  deletionStart: number;
  deletionCount: number;
}

const inHunk = (h: HunkRange, side: Side, line: number) =>
  side === 'additions' ? line >= h.additionStart && line < h.additionStart + h.additionCount : line >= h.deletionStart && line < h.deletionStart + h.deletionCount;

/**
 * One file's threads: those shown on their line in the diff, and those shown above it — outdated,
 * or on a line no hunk shows (the diff may have moved on around it). Without hunks (a binary or
 * too-large file) every thread goes above.
 */
export function splitOutdated(threads: readonly ReviewThread[], file: Pick<ChangedFile, 'path'>, hunks: readonly HunkRange[] | undefined): { inline: ReviewThread[]; above: ReviewThread[] } {
  const inline: ReviewThread[] = [];
  const above: ReviewThread[] = [];
  for (const t of threads) {
    if (t.path !== file.path) continue;
    const line = t.currentLine ?? t.line;
    if (!t.outdated && hunks?.some((h) => inHunk(h, t.side, line))) inline.push(t);
    else above.push(t);
  }
  return { inline, above };
}

/** Threads on files that are no longer in the diff at all. */
export function threadsOffDiff(threads: readonly ReviewThread[], files: readonly Pick<ChangedFile, 'path'>[]): ReviewThread[] {
  const paths = new Set(files.map((f) => f.path));
  return threads.filter((t) => !paths.has(t.path));
}

/** Open and resolved threads, and the person's comments not yet submitted. */
export function reviewCounts(threads: readonly ReviewThread[]): { open: number; resolved: number; pending: number } {
  let open = 0;
  let resolved = 0;
  let pending = 0;
  for (const t of threads) {
    if (t.status === 'open') open++;
    else if (t.status === 'resolved') resolved++;
    pending += t.comments.filter((c) => c.state === 'pending').length;
  }
  return { open, resolved, pending };
}

/** Approving needs nothing; a comment or a request for changes needs a pending comment or a summary. */
export const canSubmit = (verdict: Verdict, pending: number, body: string) => verdict === 'approve' || pending > 0 || body.trim().length > 0;

/**
 * A thread fresh from the daemon folded into the state the person sees, before the `review`
 * event that follows it arrives.
 */
export function withThread(state: ReviewState | undefined, thread: ReviewThread, review?: Review): ReviewState | undefined {
  if (!state) return state;
  const threads = state.threads.some((t) => t.id === thread.id) ? state.threads.map((t) => (t.id === thread.id ? thread : t)) : [...state.threads, thread];
  return { ...state, threads, counts: reviewCounts(threads), ...(review?.state === 'pending' ? { pending: review } : {}) };
}

/** The label on a comment: the person, Kelpie (the orchestrator), or the agent by its title. */
export function authorLabel(c: Pick<ReviewComment, 'author' | 'authorTitle'>): string {
  if (c.author === 'person') return 'You';
  if (c.author === 'orchestrator') return 'Kelpie';
  return c.authorTitle || 'Agent';
}

/** The text of one line of a parsed diff, by side and line number; undefined when no hunk shows it. */
export function lineTextAt(
  diff: { hunks: readonly (HunkRange & { additionLineIndex: number; deletionLineIndex: number })[]; additionLines: readonly string[]; deletionLines: readonly string[] },
  side: Side,
  line: number,
): string | undefined {
  for (const h of diff.hunks) {
    if (!inHunk(h, side, line)) continue;
    const text = side === 'additions' ? diff.additionLines[h.additionLineIndex + line - h.additionStart] : diff.deletionLines[h.deletionLineIndex + line - h.deletionStart];
    return text?.replace(/\r?\n$/, '');
  }
  return undefined;
}

/**
 * Where a comment being written goes when the diff under it changes (a muster, or a 409 "moved on"
 * that reloaded it), as GitHub does with a pending comment: it stays on its line if that still says
 * the same, or follows the text to the one line now saying it (`moved`). Undefined when the line is
 * gone or ambiguous: the comment's text is kept, and the person picks the line again.
 */
export function followDraft<D extends { side: Side; line: number; text: string }>(
  draft: D,
  diff: Parameters<typeof lineTextAt>[0],
): { draft: D; moved: boolean } | undefined {
  if (lineTextAt(diff, draft.side, draft.line) === draft.text) return { draft, moved: false };
  const want = draft.text.trim();
  if (!want) return undefined;
  let found: number | undefined;
  for (const h of diff.hunks) {
    const [start, count] = draft.side === 'additions' ? [h.additionStart, h.additionCount] : [h.deletionStart, h.deletionCount];
    for (let line = start; line < start + count; line++) {
      if (lineTextAt(diff, draft.side, line)?.trim() !== want) continue;
      if (found !== undefined && found !== line) return undefined;
      found = line;
    }
  }
  return found === undefined ? undefined : { draft: { ...draft, line: found, text: lineTextAt(diff, draft.side, found)! }, moved: true };
}
