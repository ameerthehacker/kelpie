import type { ReviewCommentRow, ReviewRow, ReviewThreadRow, Store } from '@kelpie/store';
import { ReviewError, ToolError } from '../errors.js';
import { NOTIFICATION_TAG, reviewBrief } from '../orchestrator/prompt.js';
import type { ManagerUpdate, Session } from '../sessions.js';
import type { Changes } from './changes.js';
import type { AgentRef, Review, ReviewComment, ReviewState, ReviewThread, Side, Verdict } from './types.js';

const PUBLISH_MS = 200;
const BODY_MAX = 10_000;
const FIRST_COMMENT_CHARS = 200;
const VERDICTS: Record<Verdict, string> = { comment: 'Comment', request_changes: 'Request changes', approve: 'Approve' };

export interface NewAnchor {
  view: 'feature' | 'agent';
  viewSessionId?: string;
  path: string;
  side: Side;
  line: number;
  commitSha: string;
  lineText: string;
}

export type CommentInput = { body: string } & ({ threadId: string } | { anchor: NewAnchor });

/** A thread as agents and the orchestrator read it (MCP): published comments only. */
export interface ToolThread {
  threadId: string;
  path: string;
  side: Side;
  line: number;
  currentLine: number | null;
  outdated: boolean;
  lineText: string;
  diffHunk: string;
  status: 'open' | 'resolved';
  /** Whose change the line is, and who it is assigned to (the orchestrator's view only). */
  agent?: { id: string | null; title: string } | null;
  assignedTo?: string | null;
  comments: { author: string; body: string; at: string }[];
}

export interface ReviewsDeps {
  /** Sends a live update to every `/api/events` client. */
  publish: (u: ManagerUpdate) => void;
  session: (id: string) => Session | undefined;
  /** Whether threads made on an agent's own Changes tab go straight to it. Without it, the orchestrator routes them all. */
  claim?: (roundUp: Session, agentId: string) => ReviewClaim;
}

/** An agent that takes review threads straight away (its slot held until `release`), or why it can't. */
export type ReviewClaim = { agent: Session; release: () => void } | { reason: string };

/** Threads sent straight to the agent whose Changes tab they were made on. */
interface DirectGroup {
  agent: Session;
  threads: ReviewThreadRow[];
}

/** One group of a submitted review's threads, by the agent they go back to (none: base code, Muster, or gone). */
export interface ReviewGroup {
  agent: { id: string; title: string } | undefined;
  threads: ReviewThreadRow[];
}

const oneLine = (text: string, max: number) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** What a body must be: 1 to 10000 characters. */
export function checkBody(body: unknown): string {
  if (typeof body !== 'string' || !body.trim() || body.length > BODY_MAX) throw new ReviewError(`body must be 1-${BODY_MAX} characters`, 400);
  return body;
}

/**
 * The person's reviews of a round-up's changes, and the threads agents answer. Everything is in
 * the store; a review's submission and its notification to the orchestrator land in one transaction.
 */
export class Reviews {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The latest state build started per round-up: only that one is sent. */
  private readonly builds = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly changes: Changes,
    private readonly deps: ReviewsDeps,
  ) {}

  // ── the person's view ────────────────────────────────────────────────

  async state(roundUpId: string): Promise<ReviewState> {
    const rows = this.store.threadsOf(roundUpId);
    const threads = await this.threads(rows);
    const pending = this.store.pendingReview(roundUpId);
    return {
      roundUpId,
      pending: pending ? this.review(pending) : null,
      reviews: this.store.submittedReviews(roundUpId, 50).map((r) => this.review(r)),
      threads,
      counts: {
        open: rows.filter((t) => t.status === 'open').length,
        resolved: rows.filter((t) => t.status === 'resolved').length,
        pending: rows.filter((t) => t.status === 'pending').length,
      },
    };
  }

  /** Adds the person's comment to their draft: a new thread on a line, or a reply. */
  async comment(roundUpId: string, input: CommentInput): Promise<{ thread: ReviewThread; review: Review }> {
    const body = checkBody(input.body);
    let threadId: string;
    if ('threadId' in input) {
      const thread = this.store.thread(input.threadId);
      if (!thread || thread.roundUpId !== roundUpId) throw new ReviewError('no such thread', 404);
      const review = this.store.ensurePendingReview(roundUpId);
      this.store.addComment({ threadId: thread.id, roundUpId, reviewId: review.id, author: 'person', authorSessionId: null, authorTitle: null, body, state: 'pending' });
      threadId = thread.id;
    } else {
      const a = input.anchor;
      let viewId = roundUpId;
      if (a.view === 'agent') {
        const agent = a.viewSessionId ? this.store.getSession(a.viewSessionId) : undefined;
        if (!agent || agent.parentId !== roundUpId) throw new ReviewError('no such agent in this round-up', 404);
        viewId = agent.id;
      }
      const found = await this.changes.anchor(viewId, a);
      if (!found.ok && found.reason === 'none') throw new ReviewError('there are no changes to comment on here', 400);
      if (!found.ok) throw new ReviewError('these changes moved on: the line no longer says that', 409, true);
      threadId = this.store.atomically(() => {
        const review = this.store.ensurePendingReview(roundUpId);
        const thread = this.store.addThread({
          roundUpId,
          view: a.view,
          viewSessionId: a.view === 'agent' ? viewId : null,
          agentId: found.owner?.id ?? null,
          agentTitle: found.owner?.title ?? null,
          path: a.path,
          side: a.side,
          line: a.line,
          commitSha: a.commitSha,
          baseSha: found.view.baseSha,
          lineText: a.lineText,
          diffHunk: found.diffHunk,
        });
        this.store.addComment({ threadId: thread.id, roundUpId, reviewId: review.id, author: 'person', authorSessionId: null, authorTitle: null, body, state: 'pending' });
        return thread.id;
      });
    }
    this.changed(roundUpId);
    const [thread] = await this.threads([this.store.thread(threadId)!]);
    return { thread: thread!, review: this.review(this.store.pendingReview(roundUpId)!) };
  }

  editComment(roundUpId: string, commentId: string, body: unknown): ReviewComment {
    const text = checkBody(body);
    this.draft(roundUpId, commentId);
    const row = this.store.updateComment(commentId, text)!;
    this.changed(roundUpId);
    return this.commentOf(row);
  }

  deleteComment(roundUpId: string, commentId: string): void {
    this.draft(roundUpId, commentId);
    this.store.deleteComment(commentId);
    this.changed(roundUpId);
  }

  discard(roundUpId: string): void {
    if (this.store.discardPending(roundUpId)) this.changed(roundUpId);
  }

  /** The person resolves (or reopens) a thread, there and then. */
  async resolveByPerson(roundUpId: string, threadId: string, resolved: boolean): Promise<ReviewThread> {
    const thread = this.store.thread(threadId);
    if (!thread || thread.roundUpId !== roundUpId) throw new ReviewError('no such thread', 404);
    if (thread.status === 'pending') throw new ReviewError('this thread is still in your draft: submit the review first', 409);
    const row = this.store.setThreadStatus(threadId, resolved ? 'resolved' : 'open', 'person')!;
    this.changed(roundUpId);
    return (await this.threads([row]))[0]!;
  }

  /**
   * Submits the draft and tells the orchestrator, in one transaction: its threads grouped by the agent
   * each goes back to. Threads made on an agent's own Changes tab go straight to that agent (assigned,
   * and its brief queued, in the same transaction) when it can take them; the orchestrator is told.
   * Refused (409) while Kelpie shuts down; then nothing is submitted.
   */
  async submit(roundUpId: string, verdict: Verdict, body = ''): Promise<{ review: Review }> {
    const orchestrator = this.deps.session(roundUpId);
    if (!orchestrator || orchestrator.parentId) throw new ReviewError('no such round-up', 404);
    if (body.length > BODY_MAX) throw new ReviewError(`body must be at most ${BODY_MAX} characters`, 400);
    const draft = this.store.pendingReview(roundUpId);
    const comments = draft ? this.store.commentsOfReview(draft.id).filter((c) => c.state === 'pending') : [];
    if (verdict !== 'approve' && !comments.length && !body.trim()) throw new ReviewError('add a comment or a summary first', 400);
    const review = draft ?? this.store.ensurePendingReview(roundUpId);
    const threads = this.store.threadsOf(roundUpId, { ids: [...new Set(comments.map((c) => c.threadId))] });
    const ids = comments.map((c) => c.id);
    const { direct, routed, refused, release } = this.route(orchestrator, threads);
    try {
      const drafted = new Set(ids);
      const together = await Promise.all(
        direct.map(async (d) => ({
          session: d.agent,
          text: reviewBrief(await this.toolThreads(d.threads, false, drafted), { direct: { verdict: VERDICTS[verdict], body } }),
          source: 'orchestrator' as const,
        })),
      );
      const text = notification(verdict, body, this.groups(roundUpId, routed), comments, direct, refused);
      await orchestrator.send(text, 'kelpie', {
        alsoInTx: () => {
          this.store.submitReview(review.id, verdict, body, ids);
          for (const d of direct) this.store.assignThreads(d.threads.map((t) => t.id), d.agent.id);
        },
        together,
        meta: {
          review: {
            reviewId: review.id,
            verdict,
            comments: ids.length,
            threads: threads.length,
            ...(direct.length ? { direct: direct.map((d) => ({ agentId: d.agent.id, title: d.agent.title, threads: d.threads.length })) } : {}),
          },
        },
      });
    } catch (err) {
      // Submitted and queued, but the harness could not start: it is sent on the next start.
      if (this.store.review(review.id)?.state !== 'submitted') {
        // An empty draft made just for this approval goes again.
        if (!draft && !this.store.commentsOfReview(review.id).length) this.store.discardPending(roundUpId);
        throw new ReviewError((err as Error).message, 409);
      }
      console.error(`round-up ${roundUpId}: review submitted, but the orchestrator did not start`, err);
    } finally {
      release();
      this.changed(roundUpId);
    }
    return { review: this.review(this.store.review(review.id)!) };
  }

  /**
   * Splits a review's threads: those made on an agent's own Changes tab that it can take now go
   * straight to it; the rest are the orchestrator's to route, with why any made on an agent's tab
   * did not go to it.
   */
  private route(roundUp: Session, threads: ReviewThreadRow[]) {
    const direct = new Map<string, DirectGroup>();
    const claims = new Map<string, ReviewClaim>();
    const routed: ReviewThreadRow[] = [];
    const refused = new Map<string, string>();
    for (const t of threads) {
      if (t.view !== 'agent' || !this.deps.claim) {
        routed.push(t);
        continue;
      }
      const id = t.viewSessionId;
      const claim = id ? (claims.get(id) ?? this.deps.claim(roundUp, id)) : { reason: 'that agent was deleted' };
      if (id) claims.set(id, claim);
      if ('reason' in claim) {
        const title = id ? this.store.getSession(id)?.title : undefined;
        refused.set(t.id, `made on ${title ? `"${title}"'s` : "an agent's"} own changes, not sent straight to it: ${claim.reason}`);
        routed.push(t);
        continue;
      }
      const group = direct.get(claim.agent.id) ?? { agent: claim.agent, threads: [] };
      group.threads.push(t);
      direct.set(claim.agent.id, group);
    }
    const release = () => claims.forEach((c) => 'release' in c && c.release());
    return { direct: [...direct.values()], routed, refused, release };
  }

  /**
   * A submitted review's threads by the agent each goes back to: who it is assigned to, else whose
   * change it is, as long as that is still a writer of this round-up (not Muster or read-only).
   */
  groups(roundUpId: string, threads: ReviewThreadRow[]): ReviewGroup[] {
    const groups = new Map<string, ReviewGroup>();
    const none: ReviewThreadRow[] = [];
    for (const t of threads) {
      const key = t.assignedTo ?? t.agentId;
      const agent = key ? this.store.getSession(key) : undefined;
      if (!agent || agent.parentId !== roundUpId || !agent.writes || agent.kind !== 'worker') {
        none.push(t);
        continue;
      }
      const group = groups.get(agent.id) ?? { agent: { id: agent.id, title: agent.title }, threads: [] };
      group.threads.push(t);
      groups.set(agent.id, group);
    }
    return [...groups.values(), ...(none.length ? [{ agent: undefined, threads: none }] : [])];
  }

  // ── agents and the orchestrator (MCP) ────────────────────────────────

  /** The threads a session may see and act on: an agent's assigned ones, or every published one for the orchestrator. */
  private visible(session: Session): ReviewThreadRow[] {
    const published = ['open', 'resolved'] as ('open' | 'resolved')[];
    return session.parentId
      ? this.store.threadsOf(session.parentId, { status: published, assignedTo: session.id })
      : this.store.threadsOf(session.id, { status: published });
  }

  private mine(session: Session, threadId: string): ReviewThreadRow {
    const thread = this.visible(session).find((t) => t.id === threadId);
    if (!thread) throw new ToolError(session.parentId ? `no review thread ${threadId} is assigned to you` : `no such review thread: ${threadId}`);
    return thread;
  }

  async list(session: Session, status: 'open' | 'resolved' | 'all' = 'open'): Promise<ToolThread[]> {
    const rows = this.visible(session).filter((t) => status === 'all' || t.status === status);
    return this.toolThreads(rows, !session.parentId);
  }

  async reply(session: Session, threadId: string, body: string): Promise<{ threadId: string; status: string }> {
    const thread = this.mine(session, threadId);
    this.addReply(session, thread, checkTool(body));
    this.changed(thread.roundUpId);
    return { threadId, status: thread.status };
  }

  async resolve(session: Session, threadId: string, body?: string): Promise<{ threadId: string; status: string }> {
    const thread = this.mine(session, threadId);
    const text = body?.trim() ? checkTool(body) : undefined;
    this.store.atomically(() => {
      if (text) this.addReply(session, thread, text);
      this.store.setThreadStatus(thread.id, 'resolved', session.id);
    });
    this.changed(thread.roundUpId);
    return { threadId, status: 'resolved' };
  }

  private addReply(session: Session, thread: ReviewThreadRow, body: string): void {
    this.store.addComment({
      threadId: thread.id,
      roundUpId: thread.roundUpId,
      reviewId: null,
      author: session.parentId ? 'agent' : 'orchestrator',
      authorSessionId: session.id,
      authorTitle: session.title,
      body,
      state: 'published',
    });
  }

  /** A submitted review (the latest by default), its threads, and every thread still open. */
  async read(roundUpId: string, reviewId?: string) {
    const review = reviewId ? this.store.review(reviewId) : this.store.submittedReviews(roundUpId, 1)[0];
    if (reviewId && (!review || review.roundUpId !== roundUpId || review.state !== 'submitted')) throw new ToolError(`no such submitted review: ${reviewId}`);
    const own = review ? [...new Set(this.store.commentsOfReview(review.id).map((c) => c.threadId))] : [];
    const threads = this.store.threadsOf(roundUpId, { ids: own, status: ['open', 'resolved'] });
    const open = this.store.threadsOf(roundUpId, { status: ['open'] });
    return {
      review: review ? { reviewId: review.id, verdict: review.verdict, body: review.body, submittedAt: review.submittedAt && new Date(review.submittedAt).toISOString() } : null,
      threads: await this.toolThreads(threads, true),
      open: await this.toolThreads(open, true),
    };
  }

  /** Open threads of this round-up among `ids`; refuses any other. */
  openThreads(roundUpId: string, ids: string[]): ReviewThreadRow[] {
    const unique = [...new Set(ids)];
    const rows = this.store.threadsOf(roundUpId, { ids: unique });
    for (const id of unique) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new ToolError(`no such review thread: ${id}`);
      if (row.status !== 'open') throw new ToolError(`review thread ${id} is ${row.status}, not open`);
    }
    return rows;
  }

  /** Threads assigned to an agent, by status: for its idle notification. */
  countsFor(roundUpId: string, agentId: string): { open: number; resolved: number } | undefined {
    const rows = this.store.threadsOf(roundUpId, { assignedTo: agentId, status: ['open', 'resolved'] });
    if (!rows.length) return undefined;
    return { open: rows.filter((t) => t.status === 'open').length, resolved: rows.filter((t) => t.status === 'resolved').length };
  }

  /** `drafted`: comments of the review being submitted, as good as published. */
  async toolThreads(rows: ReviewThreadRow[], full: boolean, drafted?: Set<string>): Promise<ToolThread[]> {
    const locate = this.changes.locator();
    const comments = this.store.commentsOf(rows.map((r) => r.id)).filter((c) => c.state === 'published' || drafted?.has(c.id));
    return Promise.all(
      rows.map(async (t) => {
        const current = await locate(t);
        return {
          threadId: t.id,
          path: t.path,
          side: t.side,
          line: t.line,
          currentLine: current ?? null,
          outdated: current === undefined,
          lineText: t.lineText,
          diffHunk: t.diffHunk,
          status: t.status as 'open' | 'resolved',
          ...(full ? { agent: t.agentTitle ? { id: t.agentId, title: t.agentTitle } : null, assignedTo: t.assignedTo } : {}),
          comments: comments
            .filter((c) => c.threadId === t.id)
            .map((c) => ({ author: c.author === 'agent' ? (c.authorTitle ?? 'agent') : c.author, body: c.body, at: new Date(c.createdAt).toISOString() })),
        };
      }),
    );
  }

  // ── building DTOs ────────────────────────────────────────────────────

  private draft(roundUpId: string, commentId: string): ReviewCommentRow {
    const c = this.store.comment(commentId);
    if (!c || c.roundUpId !== roundUpId) throw new ReviewError('no such comment', 404);
    if (c.author !== 'person' || c.state !== 'pending') throw new ReviewError('only a comment still in your draft can change', 409);
    return c;
  }

  private ref(id: string | null, title: string | null): AgentRef | undefined {
    const row = id ? this.store.getSession(id) : undefined;
    if (row) return { id: row.id, title: row.title, harness: row.harness };
    return title ? { id: null, title, harness: 'claude-code' } : undefined;
  }

  private async threads(rows: ReviewThreadRow[]): Promise<ReviewThread[]> {
    const locate = this.changes.locator();
    const comments = this.store.commentsOf(rows.map((r) => r.id));
    return Promise.all(
      rows.map(async (t) => {
        const current = await locate(t);
        const agent = this.ref(t.agentId, t.agentTitle);
        const assigned = t.assignedTo ? this.ref(t.assignedTo, null) : undefined;
        return {
          id: t.id,
          view: t.view,
          ...(t.viewSessionId ? { viewSessionId: t.viewSessionId } : {}),
          ...(agent ? { agent } : {}),
          ...(assigned ? { assignedTo: assigned } : {}),
          path: t.path,
          side: t.side,
          line: t.line,
          ...(current !== undefined ? { currentLine: current } : {}),
          outdated: current === undefined,
          commitSha: t.commitSha,
          lineText: t.lineText,
          diffHunk: t.diffHunk,
          status: t.status,
          ...(t.resolvedBy ? { resolvedBy: t.resolvedBy } : {}),
          ...(t.resolvedAt ? { resolvedAt: t.resolvedAt } : {}),
          comments: comments.filter((c) => c.threadId === t.id).map((c) => this.commentOf(c)),
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        };
      }),
    );
  }

  private commentOf(c: ReviewCommentRow): ReviewComment {
    const harness = c.authorSessionId ? this.store.getSession(c.authorSessionId)?.harness : undefined;
    return {
      id: c.id,
      threadId: c.threadId,
      author: c.author,
      ...(c.authorSessionId ? { authorId: c.authorSessionId } : {}),
      ...(c.authorTitle ? { authorTitle: c.authorTitle } : {}),
      ...(harness ? { authorHarness: harness } : {}),
      body: c.body,
      state: c.state,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  private review(r: ReviewRow): Review {
    return {
      id: r.id,
      state: r.state,
      ...(r.verdict ? { verdict: r.verdict } : {}),
      body: r.body,
      createdAt: r.createdAt,
      ...(r.submittedAt ? { submittedAt: r.submittedAt } : {}),
      commentIds: this.store.commentsOfReview(r.id).map((c) => c.id),
    };
  }

  /**
   * Something in a round-up's review changed: its whole state goes out, at most every 200 ms. A state
   * still being built when a newer one starts is dropped, so a slow build never overwrites a newer one.
   */
  changed(roundUpId: string): void {
    if (this.timers.has(roundUpId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(roundUpId);
      if (!this.deps.session(roundUpId)) {
        this.builds.delete(roundUpId);
        return;
      }
      const build = (this.builds.get(roundUpId) ?? 0) + 1;
      this.builds.set(roundUpId, build);
      this.state(roundUpId).then(
        (state) => this.builds.get(roundUpId) === build && this.deps.publish({ type: 'review', roundUpId, state }),
        (err) => console.error(`round-up ${roundUpId}: could not build its review state`, err),
      );
    }, PUBLISH_MS);
    timer.unref();
    this.timers.set(roundUpId, timer);
  }
}

function checkTool(body: string): string {
  if (!body.trim() || body.length > BODY_MAX) throw new ToolError(`body must be 1-${BODY_MAX} characters`);
  return body;
}

/** What the orchestrator reads when the person submits a review. */
function notification(verdict: Verdict, body: string, groups: ReviewGroup[], comments: ReviewCommentRow[], direct: DirectGroup[], refused: Map<string, string>): string {
  const first = (t: ReviewThreadRow) => comments.find((c) => c.threadId === t.id)?.body ?? '';
  const plural = (n: number) => `${n} thread${n === 1 ? '' : 's'}`;
  const line = (t: ReviewThreadRow) => {
    const why = refused.get(t.id);
    return `- [${t.id}] ${t.path}:${t.line} (${t.side}): "${oneLine(first(t), FIRST_COMMENT_CHARS)}"${why ? ` (${why})` : ''}`;
  };
  const parts = [
    `The person submitted a review of the feature's changes: ${VERDICTS[verdict]}.`,
    ...(body.trim() ? [body.trim().split('\n').map((l) => `> ${l}`).join('\n')] : []),
    ...groups.map((g) =>
      [
        g.agent ? `## Agent "${g.agent.title}" (${g.agent.id}): ${plural(g.threads.length)}` : `## No agent (base code, Muster, or a deleted/read-only agent): ${plural(g.threads.length)}`,
        ...g.threads.map(line),
      ].join('\n'),
    ),
    ...direct.map((d) => [`## Sent straight to agent "${d.agent.title}" (${d.agent.id}): ${plural(d.threads.length)} (made on its own changes)`, ...d.threads.map(line)].join('\n')),
    'Act on it now (see your rules). This message is from Kelpie, not the person.',
  ];
  return `<${NOTIFICATION_TAG}>\n${parts.join('\n')}\n</${NOTIFICATION_TAG}>`;
}
