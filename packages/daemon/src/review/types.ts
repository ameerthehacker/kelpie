/**
 * What the Changes and review API serves. The web mirrors these in `apps/web/src/lib/review.ts`;
 * change them together.
 */

/** Which side of a diff a line is on. Context lines are anchored as `additions`, by their new line number. */
export type Side = 'additions' | 'deletions';

export interface AgentRef {
  /** Null once the agent is deleted. */
  id: string | null;
  title: string;
  harness: string;
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary: boolean;
  /** Git-format unified diff for this file (its `diff --git ...` chunk); absent if binary or tooLarge. */
  patch?: string;
  /** More than 3000 changed lines or 400 KB, or the response's 8 MB budget was spent: load it on its own. */
  tooLarge?: boolean;
  /** Who changed it: the feature's agents with a delivery that touched it, or for one agent's view that agent. */
  agents: AgentRef[];
}

export interface Round {
  index: number;
  state: 'mustered' | 'active';
  baseSha: string;
  headSha: string;
}

export interface Changes {
  scope: 'feature' | 'agent';
  sessionId: string;
  roundUpId: string;
  /** none: no branch yet, a read-only agent, or Muster. */
  state: 'ready' | 'none';
  /** Feature: home's branch, against its base branch. Agent: its branch, against the feature branch. */
  branch?: string;
  baseRef?: string;
  /** The old and new side's commits. */
  baseSha?: string;
  headSha?: string;
  /** Agent: the diff includes uncommitted and untracked work in its worktree. */
  dirty?: boolean;
  /** Agent scope: a merge, rebase, cherry-pick or revert under way in its worktree; the files are its branch's committed work. */
  inProgress?: 'merge' | 'rebase' | 'cherry-pick' | 'revert';
  /** Where it is checked out, while on disk (for "Open in VS Code"). */
  checkoutPath?: string;
  /** Feature: every agent with a delivery. */
  musteredFrom?: AgentRef[];
  /** Agent: each time its work was mustered, and the work under way. */
  rounds?: Round[];
  round?: number;
  stats: { files: number; additions: number; deletions: number };
  files: ChangedFile[];
}

export interface ReviewComment {
  id: string;
  threadId: string;
  author: 'person' | 'orchestrator' | 'agent';
  authorId?: string;
  authorTitle?: string;
  /** An agent's harness, as it was when it wrote; absent for the person, Kelpie, and agents deleted before it was kept. */
  authorHarness?: string;
  body: string;
  state: 'pending' | 'published';
  createdAt: number;
  updatedAt: number;
}

export interface ReviewThread {
  id: string;
  view: 'feature' | 'agent';
  viewSessionId?: string;
  /** Whose change the line is; absent for base code, Muster's or unknown. */
  agent?: AgentRef;
  assignedTo?: AgentRef;
  path: string;
  side: Side;
  line: number;
  /** Where it sits in the current diff; absent when outdated. */
  currentLine?: number;
  outdated: boolean;
  commitSha: string;
  lineText: string;
  diffHunk: string;
  status: 'pending' | 'open' | 'resolved';
  /** 'person', or the id of the session that resolved it. */
  resolvedBy?: 'person' | string;
  resolvedAt?: number;
  comments: ReviewComment[];
  createdAt: number;
  updatedAt: number;
}

export type Verdict = 'comment' | 'request_changes' | 'approve';

export interface Review {
  id: string;
  state: 'pending' | 'submitted';
  verdict?: Verdict;
  body: string;
  createdAt: number;
  submittedAt?: number;
  commentIds: string[];
}

export interface ReviewState {
  roundUpId: string;
  /** The person's draft. */
  pending: Review | null;
  /** Submitted, newest first, at most 50. */
  reviews: Review[];
  threads: ReviewThread[];
  counts: { open: number; resolved: number; pending: number };
}
