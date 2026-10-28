import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { and, asc, desc, eq, gte, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { HarnessUsage, KelpieEvent, type EventData, type EventKind, type EventOf, type TicketLink, type TicketTitleSource, titleWins } from '@kelpie/protocol';
import * as schema from './schema.js';

export type SessionRow = typeof schema.sessions.$inferSelect;
export type NewSession = Omit<typeof schema.sessions.$inferInsert, 'createdAt' | 'updatedAt'>;
export type SessionPatch = Partial<Pick<SessionRow, 'title' | 'titleSource' | 'titleTurn' | 'model' | 'effort' | 'harnessSessionId' | 'resumePending' | 'notifiedIdx' | 'baseBranch' | 'baseCommit' | 'mode'>>;
export type WorktreeRow = typeof schema.worktrees.$inferSelect;
export type NewWorktree = Omit<typeof schema.worktrees.$inferInsert, 'id' | 'createdAt' | 'lastUsedAt' | 'state'>;
export type WorktreePatch = Partial<Pick<WorktreeRow, 'state' | 'lastUsedAt' | 'removedAt' | 'forkCommit'>>;
export type OutboxRow = typeof schema.outbox.$inferSelect;
export type OutboxSource = OutboxRow['source'];
export type AttachmentRow = typeof schema.attachments.$inferSelect;
export type NewAttachment = Omit<AttachmentRow, 'createdAt'>;
export type PermissionRuleRow = typeof schema.permissionRules.$inferSelect;
export type DeliveryRow = typeof schema.deliveries.$inferSelect;
export type NewDelivery = Omit<DeliveryRow, 'id' | 'createdAt'>;
export type ReviewRow = typeof schema.reviews.$inferSelect;
export type ReviewVerdict = NonNullable<ReviewRow['verdict']>;
export type ReviewThreadRow = typeof schema.reviewThreads.$inferSelect;
export type ThreadStatus = ReviewThreadRow['status'];
export type NewThread = Omit<ReviewThreadRow, 'id' | 'status' | 'assignedTo' | 'resolvedBy' | 'resolvedAt' | 'createdAt' | 'updatedAt'> & { id?: string; status?: ThreadStatus };
export type ReviewCommentRow = typeof schema.reviewComments.$inferSelect;
export type NewComment = Omit<ReviewCommentRow, 'id' | 'authorHarness' | 'createdAt' | 'updatedAt'> & { id?: string; authorHarness?: string | null };
export interface ThreadFilter {
  status?: ThreadStatus[];
  assignedTo?: string;
  ids?: string[];
}
export interface ConnectionRow extends Omit<typeof schema.connections.$inferSelect, 'scopes'> {
  scopes: string[] | null;
}
export type NewConnection = Omit<ConnectionRow, 'createdAt' | 'updatedAt'>;
export type TicketRow = typeof schema.tickets.$inferSelect;
export type TicketSource = TicketRow['source'];
export interface CardRow extends Omit<typeof schema.workbenchCards.$inferSelect, 'tickets'> {
  tickets: unknown[];
}
export type NewCard = Pick<CardRow, 'roundUpId' | 'title' | 'stage'> & Partial<Pick<CardRow, 'id' | 'callout' | 'tickets'>>;
export type CardPatchRow = Partial<Pick<CardRow, 'title' | 'stage' | 'callout' | 'tickets' | 'archivedAt' | 'doneAt'>>;
export type ItemRow = typeof schema.workbenchItems.$inferSelect;
export type ItemStatusRow = ItemRow['status'];
/** An item's fields to change, by key; on a new item, `title` defaults to the key and `status` to draft. */
export type ItemUpsert = Pick<ItemRow, 'key'> & Partial<Pick<ItemRow, 'title' | 'ref' | 'url' | 'status' | 'agentId'>>;
export interface EntryRow extends Omit<typeof schema.workbenchEntries.$inferSelect, 'claims'> {
  claims: string[];
}
export type EntryPatch = Partial<Pick<EntryRow, 'focus' | 'claims' | 'blocker' | 'progress'>>;
export type NoteRow = typeof schema.workbenchNotes.$inferSelect;
export type NewNote = Omit<NoteRow, 'id' | 'createdAt' | 'deliveredAt'>;
export type UsageLimitRow = typeof schema.usageLimits.$inferSelect;
export type NewUsageLimit = Omit<UsageLimitRow, 'createdAt' | 'attempts' | 'auto'> & Partial<Pick<UsageLimitRow, 'attempts' | 'auto'>>;

const MIGRATIONS = join(import.meta.dirname, '../drizzle');

export interface StoreOptions {
  /** Where the migrations are, when not beside this source (a bundled build ships its own copy). */
  migrationsFolder?: string;
}

/**
 * Kelpie's persistent state: round-ups and their event logs. Synchronous, like
 * better-sqlite3 underneath, so a write is done by the time the call returns.
 */
export class Store {
  private readonly db: BetterSQLite3Database<typeof schema>;

  constructor(
    private readonly sqlite: Database.Database,
    opts: StoreOptions = {},
  ) {
    sqlite.pragma('journal_mode = WAL');
    // Safe with WAL (no corruption); a power cut may lose the last commits. Without it every
    // streamed event would fsync on the event loop.
    sqlite.pragma('synchronous = NORMAL');
    sqlite.pragma('foreign_keys = ON');
    this.db = drizzle(sqlite, { schema });
    migrate(this.db, { migrationsFolder: opts.migrationsFolder ?? MIGRATIONS });
  }

  createSession(s: NewSession, now = Date.now()): SessionRow {
    return this.db.insert(schema.sessions).values({ ...s, createdAt: now, updatedAt: now }).returning().get();
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
  }

  /** Most recently active first. */
  listSessions(): SessionRow[] {
    return this.db.select().from(schema.sessions).orderBy(desc(schema.sessions.updatedAt), desc(schema.sessions.createdAt)).all();
  }

  /** An orchestrator's sub-agents, oldest first. */
  listChildren(parentId: string): SessionRow[] {
    return this.db.select().from(schema.sessions).where(eq(schema.sessions.parentId, parentId)).orderBy(asc(schema.sessions.createdAt)).all();
  }

  updateSession(id: string, patch: SessionPatch): SessionRow | undefined {
    return this.db.update(schema.sessions).set(patch).where(eq(schema.sessions.id, id)).returning().get();
  }

  /** Removes the round-up and, by cascade, its events. */
  deleteSession(id: string): boolean {
    return this.db.delete(schema.sessions).where(eq(schema.sessions.id, id)).run().changes > 0;
  }

  /**
   * Logs an event. With `deliveredId`, the event is the harness echoing that outbox row: it is
   * marked delivered in the same transaction, so a turn is never both logged and sent again
   * after a crash.
   */
  appendEvent(sessionId: string, idx: number, event: KelpieEvent, now = Date.now(), deliveredId?: number): void {
    this.db.transaction((tx) => {
      tx.insert(schema.events).values({ sessionId, idx, kind: event.kind, event: JSON.stringify(event) }).run();
      tx.update(schema.sessions).set({ updatedAt: now }).where(eq(schema.sessions.id, sessionId)).run();
      if (deliveredId !== undefined) tx.update(schema.outbox).set({ deliveredAt: now }).where(eq(schema.outbox.id, deliveredId)).run();
    });
  }

  /** Records a turn about to be sent to a round-up. `meta` is merged into its echo's `message` data. */
  enqueue(sessionId: string, text: string, source: OutboxSource, now = Date.now(), meta?: Record<string, unknown>): OutboxRow {
    return this.db
      .insert(schema.outbox)
      .values({ sessionId, text, source, createdAt: now, ...(meta ? { meta: JSON.stringify(meta) } : {}) })
      .returning()
      .get();
  }

  /** Turns sent (or about to be) that the harness has not taken in yet, oldest first. */
  undelivered(sessionId: string): OutboxRow[] {
    return this.db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.sessionId, sessionId), isNull(schema.outbox.deliveredAt)))
      .orderBy(asc(schema.outbox.id))
      .all();
  }

  /** Sum of the per-turn costs in a round-up's log. */
  costOf(sessionId: string): number {
    return (
      this.db
        .select({ cost: sql<number | null>`sum(json_extract(${schema.events.event}, '$.data.costUsd'))` })
        .from(schema.events)
        .where(and(eq(schema.events.sessionId, sessionId), eq(schema.events.kind, 'usage')))
        .get()?.cost ?? 0
    );
  }

  /** Drops turns that will never be taken in (their process died before it read them). */
  discardUndelivered(sessionId: string, now = Date.now()): void {
    this.db
      .update(schema.outbox)
      .set({ deliveredAt: now })
      .where(and(eq(schema.outbox.sessionId, sessionId), isNull(schema.outbox.deliveredAt)))
      .run();
  }

  /** The first turn a round-up was sent (a sub-agent's task brief). */
  /** Every turn queued for a round-up at or after `since` (epoch ms), delivered or not, oldest first. */
  sentSince(sessionId: string, since: number): OutboxRow[] {
    return this.db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.sessionId, sessionId), gte(schema.outbox.createdAt, since)))
      .orderBy(asc(schema.outbox.id))
      .all();
  }

  firstSent(sessionId: string): OutboxRow | undefined {
    return this.db.select().from(schema.outbox).where(eq(schema.outbox.sessionId, sessionId)).orderBy(asc(schema.outbox.id)).limit(1).get();
  }

  loadEvents(sessionId: string): KelpieEvent[] {
    return this.db
      .select({ event: schema.events.event })
      .from(schema.events)
      .where(eq(schema.events.sessionId, sessionId))
      .orderBy(asc(schema.events.idx))
      .all()
      .map((r) => KelpieEvent.parse(JSON.parse(r.event)));
  }

  /** The latest event in a round-up, or the latest of one kind, without loading the whole log. */
  lastEvent(sessionId: string): KelpieEvent | undefined;
  lastEvent<K extends EventKind>(sessionId: string, kind: K): EventOf<K> | undefined;
  lastEvent(sessionId: string, kind?: EventKind): KelpieEvent | undefined {
    const row = this.db
      .select({ event: schema.events.event })
      .from(schema.events)
      .where(and(eq(schema.events.sessionId, sessionId), kind ? eq(schema.events.kind, kind) : undefined))
      .orderBy(desc(schema.events.idx))
      .limit(1)
      .get();
    return row ? KelpieEvent.parse(JSON.parse(row.event)) : undefined;
  }

  /** The latest event a harness run logged: not one of Kelpie's own entries (`halt`). */
  lastRunEvent(sessionId: string): KelpieEvent | undefined {
    const row = this.db
      .select({ event: schema.events.event })
      .from(schema.events)
      .where(and(eq(schema.events.sessionId, sessionId), ne(schema.events.kind, 'halt')))
      .orderBy(desc(schema.events.idx))
      .limit(1)
      .get();
    return row ? KelpieEvent.parse(JSON.parse(row.event)) : undefined;
  }

  /** Like `lastEvent`, with the event's index in the log. */
  lastEventAt<K extends EventKind>(sessionId: string, kind: K): { index: number; event: EventOf<K> } | undefined {
    const row = this.db
      .select({ idx: schema.events.idx, event: schema.events.event })
      .from(schema.events)
      .where(and(eq(schema.events.sessionId, sessionId), eq(schema.events.kind, kind)))
      .orderBy(desc(schema.events.idx))
      .limit(1)
      .get();
    return row ? { index: row.idx, event: KelpieEvent.parse(JSON.parse(row.event)) as EventOf<K> } : undefined;
  }

  /** The latest `limit` events of the given kinds, newest first. */
  recentEvents(sessionId: string, kinds: EventKind[], limit: number): KelpieEvent[] {
    return this.db
      .select({ event: schema.events.event })
      .from(schema.events)
      .where(and(eq(schema.events.sessionId, sessionId), inArray(schema.events.kind, kinds)))
      .orderBy(desc(schema.events.idx))
      .limit(limit)
      .all()
      .map((r) => KelpieEvent.parse(JSON.parse(r.event)));
  }

  /** The first `limit` events of the given kinds, oldest first. */
  firstEvents(sessionId: string, kinds: EventKind[], limit: number): KelpieEvent[] {
    return this.db
      .select({ event: schema.events.event })
      .from(schema.events)
      .where(and(eq(schema.events.sessionId, sessionId), inArray(schema.events.kind, kinds)))
      .orderBy(schema.events.idx)
      .limit(limit)
      .all()
      .map((r) => KelpieEvent.parse(JSON.parse(r.event)));
  }

  /** How many turns the person has sent the session (the harness's echoes of them). */
  personTurns(sessionId: string): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(schema.events)
        .where(and(eq(schema.events.sessionId, sessionId), eq(schema.events.kind, 'message'), sql`json_extract(${schema.events.event}, '$.data.source') = 'user'`))
        .get()?.n ?? 0
    );
  }

  /** Runs `fn` in one transaction: every write in it lands, or none does. */
  atomically<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }

  eventCount(sessionId: string): number {
    return this.db.select({ n: sql<number>`count(*)` }).from(schema.events).where(eq(schema.events.sessionId, sessionId)).get()?.n ?? 0;
  }

  /** Keeps a harness's latest usage (the caller merges reports; see `mergeUsage`). */
  setUsage(harness: string, usage: EventData<'rate_limit'>, now = Date.now()): void {
    const row = { harness, usage: JSON.stringify(usage), updatedAt: now };
    this.db.insert(schema.harnessUsage).values(row).onConflictDoUpdate({ target: schema.harnessUsage.harness, set: row }).run();
  }

  /** Rows that no longer parse (written by another version) are skipped: usage is advisory. */
  listUsage(): HarnessUsage[] {
    return this.db
      .select()
      .from(schema.harnessUsage)
      .all()
      .flatMap((r) => {
        let usage: unknown;
        try {
          usage = JSON.parse(r.usage);
        } catch {
          return [];
        }
        const parsed = HarnessUsage.safeParse({ harness: r.harness, usage, updatedAt: r.updatedAt });
        return parsed.success ? [parsed.data] : [];
      });
  }

  /** Records a worktree about to be made (state `creating`); `git worktree add` runs after. */
  createWorktree(w: NewWorktree, now = Date.now()): WorktreeRow {
    return this.db.insert(schema.worktrees).values({ ...w, state: 'creating', createdAt: now, lastUsedAt: now }).returning().get();
  }

  updateWorktree(id: number, patch: WorktreePatch): WorktreeRow | undefined {
    return this.db.update(schema.worktrees).set(patch).where(eq(schema.worktrees.id, id)).returning().get();
  }

  /** The worktree a session works in, if it has one. */
  worktreeOf(sessionId: string): WorktreeRow | undefined {
    return this.db.select().from(schema.worktrees).where(eq(schema.worktrees.sessionId, sessionId)).get();
  }

  /** Every worktree of a round-up (its home and its agents'), oldest first. */
  worktreesOf(roundUpId: string): WorktreeRow[] {
    return this.db.select().from(schema.worktrees).where(eq(schema.worktrees.roundUpId, roundUpId)).orderBy(asc(schema.worktrees.id)).all();
  }

  /** Worktrees that may be on disk: every one not yet removed. */
  liveWorktrees(): WorktreeRow[] {
    return this.db
      .select()
      .from(schema.worktrees)
      .where(inArray(schema.worktrees.state, ['creating', 'active']))
      .orderBy(asc(schema.worktrees.lastUsedAt))
      .all();
  }

  /** Every worktree row, removed ones included: the repos Kelpie has ever worked in. */
  allWorktrees(): WorktreeRow[] {
    return this.db.select().from(schema.worktrees).orderBy(asc(schema.worktrees.id)).all();
  }

  addAttachment(a: NewAttachment, now = Date.now()): AttachmentRow {
    return this.db.insert(schema.attachments).values({ ...a, createdAt: now }).returning().get();
  }

  /** The given attachments of one round-up, in the order asked; ids from elsewhere (or unknown) are left out. */
  attachmentsOf(roundUpId: string, ids: string[]): AttachmentRow[] {
    if (!ids.length) return [];
    const rows = this.db
      .select()
      .from(schema.attachments)
      .where(and(eq(schema.attachments.roundUpId, roundUpId), inArray(schema.attachments.id, ids)))
      .all();
    return ids.flatMap((id) => rows.filter((r) => r.id === id));
  }

  /** Saves a rule for a round-up; saving one it has already is a no-op. */
  addRule(roundUpId: string, rule: string, now = Date.now()): void {
    this.db.insert(schema.permissionRules).values({ roundUpId, rule, createdAt: now }).onConflictDoNothing().run();
  }

  /** A round-up's saved rules, oldest first. */
  rulesOf(roundUpId: string): PermissionRuleRow[] {
    return this.db.select().from(schema.permissionRules).where(eq(schema.permissionRules.roundUpId, roundUpId)).orderBy(asc(schema.permissionRules.id)).all();
  }

  /** Removes every round-up's rules that start with one of `prefixes` (e.g. `mcp__github__`); how many went. */
  deleteRulesStartingWith(prefixes: readonly string[]): number {
    if (!prefixes.length) return 0;
    const ids = this.db
      .select({ id: schema.permissionRules.id, rule: schema.permissionRules.rule })
      .from(schema.permissionRules)
      .all()
      .filter((r) => prefixes.some((p) => r.rule.startsWith(p)))
      .map((r) => r.id);
    if (!ids.length) return 0;
    return this.db.delete(schema.permissionRules).where(inArray(schema.permissionRules.id, ids)).run().changes;
  }

  /** Removes one of a round-up's rules; false if it has no such rule. */
  deleteRule(roundUpId: string, id: number): boolean {
    return this.db.delete(schema.permissionRules).where(and(eq(schema.permissionRules.id, id), eq(schema.permissionRules.roundUpId, roundUpId))).run().changes > 0;
  }

  // ── deliveries and reviews ───────────────────────────────────────────

  /** Records a branch as it was mustered; one already recorded (same round-up and tip) is a no-op. */
  addDelivery(d: NewDelivery, now = Date.now()): void {
    this.db.insert(schema.deliveries).values({ ...d, createdAt: now }).onConflictDoNothing().run();
  }

  /** A round-up's deliveries, oldest first. */
  deliveriesOf(roundUpId: string): DeliveryRow[] {
    return this.db.select().from(schema.deliveries).where(eq(schema.deliveries.roundUpId, roundUpId)).orderBy(asc(schema.deliveries.id)).all();
  }

  /** The person's draft review of a round-up, if they have one. */
  pendingReview(roundUpId: string): ReviewRow | undefined {
    return this.db
      .select()
      .from(schema.reviews)
      .where(and(eq(schema.reviews.roundUpId, roundUpId), eq(schema.reviews.state, 'pending')))
      .get();
  }

  /** The draft review, made if there is none yet. */
  ensurePendingReview(roundUpId: string, now = Date.now()): ReviewRow {
    return this.atomically(
      () => this.pendingReview(roundUpId) ?? this.db.insert(schema.reviews).values({ id: randomUUID(), roundUpId, state: 'pending', createdAt: now }).returning().get(),
    );
  }

  review(id: string): ReviewRow | undefined {
    return this.db.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get();
  }

  /** Submitted reviews, newest first. */
  submittedReviews(roundUpId: string, limit = 50): ReviewRow[] {
    return this.db
      .select()
      .from(schema.reviews)
      .where(and(eq(schema.reviews.roundUpId, roundUpId), eq(schema.reviews.state, 'submitted')))
      .orderBy(desc(schema.reviews.submittedAt), desc(sql`rowid`))
      .limit(limit)
      .all();
  }

  addThread(t: NewThread, now = Date.now()): ReviewThreadRow {
    return this.db
      .insert(schema.reviewThreads)
      .values({ ...t, id: t.id ?? randomUUID(), status: t.status ?? 'pending', createdAt: now, updatedAt: now })
      .returning()
      .get();
  }

  addComment(c: NewComment, now = Date.now()): ReviewCommentRow {
    return this.atomically(() => {
      const row = this.db
        .insert(schema.reviewComments)
        .values({ ...c, id: c.id ?? randomUUID(), createdAt: now, updatedAt: now })
        .returning()
        .get();
      this.db.update(schema.reviewThreads).set({ updatedAt: now }).where(eq(schema.reviewThreads.id, c.threadId)).run();
      return row;
    });
  }

  comment(id: string): ReviewCommentRow | undefined {
    return this.db.select().from(schema.reviewComments).where(eq(schema.reviewComments.id, id)).get();
  }

  updateComment(id: string, body: string, now = Date.now()): ReviewCommentRow | undefined {
    return this.db.update(schema.reviewComments).set({ body, updatedAt: now }).where(eq(schema.reviewComments.id, id)).returning().get();
  }

  /** Deletes a comment; a thread left without any goes too. */
  deleteComment(id: string): boolean {
    return this.atomically(() => {
      const row = this.db.delete(schema.reviewComments).where(eq(schema.reviewComments.id, id)).returning().get();
      if (!row) return false;
      const left = this.db.select({ n: sql<number>`count(*)` }).from(schema.reviewComments).where(eq(schema.reviewComments.threadId, row.threadId)).get()?.n ?? 0;
      if (!left) this.db.delete(schema.reviewThreads).where(eq(schema.reviewThreads.id, row.threadId)).run();
      return true;
    });
  }

  /** Throws the person's draft away: its comments, the threads only it started, and the review itself. */
  discardPending(roundUpId: string): boolean {
    return this.atomically(() => {
      const review = this.pendingReview(roundUpId);
      if (!review) return false;
      this.db.delete(schema.reviewComments).where(eq(schema.reviewComments.reviewId, review.id)).run();
      this.db.delete(schema.reviewThreads).where(and(eq(schema.reviewThreads.roundUpId, roundUpId), eq(schema.reviewThreads.status, 'pending'))).run();
      this.db.delete(schema.reviews).where(eq(schema.reviews.id, review.id)).run();
      return true;
    });
  }

  /** A round-up's threads, oldest first. */
  threadsOf(roundUpId: string, filter: ThreadFilter = {}): ReviewThreadRow[] {
    const t = schema.reviewThreads;
    if (filter.ids && !filter.ids.length) return [];
    return this.db
      .select()
      .from(t)
      .where(
        and(
          eq(t.roundUpId, roundUpId),
          filter.status ? inArray(t.status, filter.status) : undefined,
          filter.assignedTo ? eq(t.assignedTo, filter.assignedTo) : undefined,
          filter.ids ? inArray(t.id, filter.ids) : undefined,
        ),
      )
      .orderBy(asc(t.createdAt), asc(sql`rowid`))
      .all();
  }

  thread(id: string): ReviewThreadRow | undefined {
    return this.db.select().from(schema.reviewThreads).where(eq(schema.reviewThreads.id, id)).get();
  }

  /** The comments on these threads, oldest first. */
  commentsOf(threadIds: string[]): ReviewCommentRow[] {
    if (!threadIds.length) return [];
    return this.db
      .select()
      .from(schema.reviewComments)
      .where(inArray(schema.reviewComments.threadId, threadIds))
      .orderBy(asc(schema.reviewComments.createdAt), asc(sql`rowid`))
      .all();
  }

  /** The comments a review holds (published with it, or still in the draft). */
  commentsOfReview(reviewId: string): ReviewCommentRow[] {
    return this.db.select().from(schema.reviewComments).where(eq(schema.reviewComments.reviewId, reviewId)).orderBy(asc(schema.reviewComments.createdAt), asc(sql`rowid`)).all();
  }

  /** Opens or resolves a thread; `by` is 'person' or the session that resolved it. */
  setThreadStatus(id: string, status: ThreadStatus, by: string | null, now = Date.now()): ReviewThreadRow | undefined {
    const resolved = status === 'resolved';
    return this.db
      .update(schema.reviewThreads)
      .set({ status, resolvedBy: resolved ? by : null, resolvedAt: resolved ? now : null, updatedAt: now })
      .where(eq(schema.reviewThreads.id, id))
      .returning()
      .get();
  }

  assignThreads(ids: string[], sessionId: string, now = Date.now()): void {
    if (!ids.length) return;
    this.db.update(schema.reviewThreads).set({ assignedTo: sessionId, updatedAt: now }).where(inArray(schema.reviewThreads.id, ids)).run();
  }

  /**
   * Submits the draft, in one transaction: exactly `commentIds` are published, their threads open
   * (again), and the review is marked submitted. Any other comment still pending in it (added while
   * the person was submitting) moves to a fresh draft.
   */
  submitReview(reviewId: string, verdict: ReviewVerdict, body: string, commentIds: string[], now = Date.now()): ReviewRow {
    return this.atomically(() => {
      const review = this.review(reviewId);
      if (!review || review.state !== 'pending') throw new Error('that review is not a draft any more');
      const c = schema.reviewComments;
      const published = commentIds.length
        ? this.db
            .update(c)
            .set({ state: 'published', updatedAt: now })
            .where(and(eq(c.reviewId, reviewId), eq(c.state, 'pending'), inArray(c.id, commentIds)))
            .returning()
            .all()
        : [];
      const threads = [...new Set(published.map((p) => p.threadId))];
      if (threads.length) {
        const t = schema.reviewThreads;
        this.db
          .update(t)
          .set({ status: 'open', resolvedBy: null, resolvedAt: null, updatedAt: now })
          .where(and(inArray(t.id, threads), ne(t.status, 'open')))
          .run();
      }
      const done = this.db.update(schema.reviews).set({ state: 'submitted', verdict, body, submittedAt: now }).where(eq(schema.reviews.id, reviewId)).returning().get();
      const strays = this.db
        .select({ id: c.id })
        .from(c)
        .where(and(eq(c.reviewId, reviewId), eq(c.state, 'pending'), commentIds.length ? notInArray(c.id, commentIds) : undefined))
        .all();
      if (strays.length) {
        const fresh = this.ensurePendingReview(review.roundUpId, now);
        this.db.update(c).set({ reviewId: fresh.id }).where(inArray(c.id, strays.map((s) => s.id))).run();
      }
      return done!;
    });
  }

  /** Saves a connector's secret, replacing the one it had. */
  setConnection(c: NewConnection, now = Date.now()): void {
    const row = { ...c, scopes: c.scopes ? JSON.stringify(c.scopes) : null, updatedAt: now };
    this.db
      .insert(schema.connections)
      .values({ ...row, createdAt: now })
      .onConflictDoUpdate({ target: schema.connections.provider, set: row })
      .run();
  }

  getConnection(provider: string): ConnectionRow | undefined {
    const row = this.db.select().from(schema.connections).where(eq(schema.connections.provider, provider)).get();
    return row && { ...row, scopes: row.scopes ? (JSON.parse(row.scopes) as string[]) : null };
  }

  /** Forgets a connector's secret; false if it had none. */
  deleteConnection(provider: string): boolean {
    return this.db.delete(schema.connections).where(eq(schema.connections.provider, provider)).run().changes > 0;
  }

  /** Every saved setting, by key, its value parsed from JSON. Settings never saved are left out. */
  settings(): Record<string, unknown> {
    return Object.fromEntries(this.db.select().from(schema.settings).all().map((r) => [r.key, JSON.parse(r.value) as unknown]));
  }

  /** Saves settings (each value as JSON), all or none; null forgets one, so it has its default again. */
  setSettings(values: Record<string, unknown>, now = Date.now()): void {
    this.atomically(() => {
      for (const [key, v] of Object.entries(values)) {
        if (v === null) {
          this.db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
          continue;
        }
        const value = JSON.stringify(v);
        this.db.insert(schema.settings).values({ key, value, updatedAt: now }).onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: now } }).run();
      }
    });
  }

  /**
   * Links a ticket to a round-up, once: linking one it has (by `ref`, whatever form the link
   * took) only sets its title, if one is given (`t.title` unless `title` says otherwise) and its
   * current title is not from a stronger source (see titleWins). True if anything changed.
   */
  linkTicket(roundUpId: string, t: TicketLink, source: TicketSource, title?: string, titleSource: TicketTitleSource = source === 'orchestrator' ? 'orchestrator' : 'link', now = Date.now()): boolean {
    const name = (title ?? t.title)?.trim() || null;
    return this.atomically(() => {
      const added = this.db
        .insert(schema.tickets)
        .values({ roundUpId, ref: t.ref, provider: t.provider, kind: t.kind, url: t.url, key: t.key ?? null, title: name, titleSource: name ? titleSource : null, source, createdAt: now })
        .onConflictDoNothing()
        .run().changes;
      if (added || !name) return added > 0;
      return this.titleTicket(roundUpId, t.ref, name, titleSource) === true;
    });
  }

  /**
   * Sets (or, with no title, clears) a linked ticket's title, unless its current one is from a
   * stronger source (see titleWins); the person's title always wins. True if it changed, false if
   * not, undefined if the round-up has no such ticket.
   */
  titleTicket(roundUpId: string, ref: string, title: string | undefined, titleSource: TicketTitleSource): boolean | undefined {
    const name = title?.trim() || null;
    const where = and(eq(schema.tickets.roundUpId, roundUpId), eq(schema.tickets.ref, ref));
    return this.atomically(() => {
      const row = this.db.select({ title: schema.tickets.title, titleSource: schema.tickets.titleSource }).from(schema.tickets).where(where).get();
      if (!row) return undefined;
      if (!titleWins(titleSource, row.title ? row.titleSource : null)) return false;
      if (row.title === name && (!name || row.titleSource === titleSource)) return false;
      this.db.update(schema.tickets).set({ title: name, titleSource: name ? titleSource : null }).where(where).run();
      return true;
    });
  }

  /** A round-up's tickets, in the order they were linked. */
  ticketsOf(roundUpId: string): TicketRow[] {
    return this.db.select().from(schema.tickets).where(eq(schema.tickets.roundUpId, roundUpId)).orderBy(asc(schema.tickets.id)).all();
  }

  /** Unlinks one of a round-up's tickets by its `ref`; false if it has no such ticket. */
  unlinkTicket(roundUpId: string, ref: string): boolean {
    return this.db.delete(schema.tickets).where(and(eq(schema.tickets.roundUpId, roundUpId), eq(schema.tickets.ref, ref))).run().changes > 0;
  }

  // ── workbench ────────────────────────────────────────────────────────

  createCard(c: NewCard, now = Date.now()): CardRow {
    const row = this.db
      .insert(schema.workbenchCards)
      .values({ ...c, id: c.id ?? randomUUID(), tickets: JSON.stringify(c.tickets ?? []), doneAt: c.stage === 'done' ? now : null, createdAt: now, updatedAt: now })
      .returning()
      .get();
    return cardOf(row);
  }

  card(id: string): CardRow | undefined {
    const row = this.db.select().from(schema.workbenchCards).where(eq(schema.workbenchCards.id, id)).get();
    return row && cardOf(row);
  }

  /** Every card, or one round-up's; oldest first. */
  cards(roundUpId?: string): CardRow[] {
    return this.db
      .select()
      .from(schema.workbenchCards)
      .where(roundUpId ? eq(schema.workbenchCards.roundUpId, roundUpId) : undefined)
      .orderBy(asc(schema.workbenchCards.createdAt), asc(sql`rowid`))
      .all()
      .map(cardOf);
  }

  /** Changes the fields given, and the card's `updatedAt`. */
  updateCard(id: string, patch: CardPatchRow, now = Date.now()): CardRow | undefined {
    const { tickets, ...rest } = patch;
    const row = this.db
      .update(schema.workbenchCards)
      .set({ ...rest, ...(tickets ? { tickets: JSON.stringify(tickets) } : {}), updatedAt: now })
      .where(eq(schema.workbenchCards.id, id))
      .returning()
      .get();
    return row && cardOf(row);
  }

  /** Inserts the item, or changes only the fields given on the one with its key. */
  upsertItem(cardId: string, item: ItemUpsert, now = Date.now()): ItemRow {
    const set = Object.fromEntries(Object.entries(item).filter(([k, v]) => k !== 'key' && v !== undefined));
    return this.db
      .insert(schema.workbenchItems)
      .values({ title: item.key, status: 'draft', ...set, cardId, key: item.key, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [schema.workbenchItems.cardId, schema.workbenchItems.key], set: { ...set, updatedAt: now } })
      .returning()
      .get();
  }

  removeItem(cardId: string, key: string): boolean {
    return this.db.delete(schema.workbenchItems).where(and(eq(schema.workbenchItems.cardId, cardId), eq(schema.workbenchItems.key, key))).run().changes > 0;
  }

  /** The items of these cards, oldest first. */
  itemsOf(cardIds: string[]): ItemRow[] {
    if (!cardIds.length) return [];
    return this.db.select().from(schema.workbenchItems).where(inArray(schema.workbenchItems.cardId, cardIds)).orderBy(asc(schema.workbenchItems.createdAt), asc(sql`rowid`)).all();
  }

  /** The items an agent is behind, on any card. */
  itemsOfAgent(agentId: string): ItemRow[] {
    return this.db.select().from(schema.workbenchItems).where(eq(schema.workbenchItems.agentId, agentId)).all();
  }

  /** Sets the fields given of an agent's own entry, making it if it has none. */
  setEntry(sessionId: string, roundUpId: string, patch: EntryPatch, now = Date.now()): EntryRow {
    const { claims, ...rest } = patch;
    const set = { ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), ...(claims ? { claims: JSON.stringify(claims) } : {}), updatedAt: now };
    const row = this.db
      .insert(schema.workbenchEntries)
      .values({ sessionId, roundUpId, ...set })
      .onConflictDoUpdate({ target: schema.workbenchEntries.sessionId, set })
      .returning()
      .get();
    return entryOf(row);
  }

  /** The entries of these round-ups' agents. */
  entriesOf(roundUpIds: string[]): EntryRow[] {
    if (!roundUpIds.length) return [];
    return this.db.select().from(schema.workbenchEntries).where(inArray(schema.workbenchEntries.roundUpId, roundUpIds)).all().map(entryOf);
  }

  addNote(n: NewNote, now = Date.now()): NoteRow {
    return this.db.insert(schema.workbenchNotes).values({ ...n, createdAt: now }).returning().get();
  }

  /** A round-up's latest notes (or one card's), oldest first. */
  notesOf(roundUpId: string, opts: { cardId?: string; limit?: number } = {}): NoteRow[] {
    const n = schema.workbenchNotes;
    return this.db
      .select()
      .from(n)
      .where(and(eq(n.roundUpId, roundUpId), opts.cardId ? eq(n.cardId, opts.cardId) : undefined))
      .orderBy(desc(n.id))
      .limit(opts.limit ?? 20)
      .all()
      .reverse();
  }

  /** How many notes a card has. */
  noteCount(cardId: string): number {
    return this.db.select({ n: sql<number>`count(*)` }).from(schema.workbenchNotes).where(eq(schema.workbenchNotes.cardId, cardId)).get()?.n ?? 0;
  }

  /** Notes to a session it has not been handed yet, oldest first. */
  undeliveredNotes(toId: string): NoteRow[] {
    const n = schema.workbenchNotes;
    return this.db.select().from(n).where(and(eq(n.toId, toId), isNull(n.deliveredAt))).orderBy(asc(n.id)).all();
  }

  markNotesDelivered(ids: number[], now = Date.now()): void {
    if (!ids.length) return;
    this.db.update(schema.workbenchNotes).set({ deliveredAt: now }).where(inArray(schema.workbenchNotes.id, ids)).run();
  }

  /** Notes `fromId` posted since `since` (epoch ms): to `toId` only, when given. */
  notesFromSince(fromId: string, since: number, toId?: string): number {
    const n = schema.workbenchNotes;
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(n)
        .where(and(eq(n.fromId, fromId), sql`${n.createdAt} >= ${since}`, toId ? eq(n.toId, toId) : undefined))
        .get()?.n ?? 0
    );
  }

  // ── usage limits ─────────────────────────────────────────────────────

  /** Records (or updates) a session's pause at its usage limit; when it first paused is kept. */
  setLimit(l: NewUsageLimit, now = Date.now()): UsageLimitRow {
    const { sessionId, ...set } = l;
    return this.db
      .insert(schema.usageLimits)
      .values({ ...l, createdAt: now })
      .onConflictDoUpdate({ target: schema.usageLimits.sessionId, set })
      .returning()
      .get();
  }

  /** Changes a pause; undefined if the session has none. */
  updateLimit(sessionId: string, patch: Partial<Pick<UsageLimitRow, 'retryAt' | 'attempts' | 'auto'>>): UsageLimitRow | undefined {
    return this.db.update(schema.usageLimits).set(patch).where(eq(schema.usageLimits.sessionId, sessionId)).returning().get();
  }

  limitOf(sessionId: string): UsageLimitRow | undefined {
    return this.db.select().from(schema.usageLimits).where(eq(schema.usageLimits.sessionId, sessionId)).get();
  }

  /** Every paused session, soonest to resume first. */
  limits(): UsageLimitRow[] {
    return this.db.select().from(schema.usageLimits).orderBy(asc(schema.usageLimits.retryAt), asc(schema.usageLimits.createdAt)).all();
  }

  /** The session runs again (or was deleted): no longer paused. False if it was not. */
  clearLimit(sessionId: string): boolean {
    return this.db.delete(schema.usageLimits).where(eq(schema.usageLimits.sessionId, sessionId)).run().changes > 0;
  }

  // ── halts ("Stop all") ───────────────────────────────────────────────

  /** Marks a session stopped by the person; when it first was is kept. */
  setHalt(sessionId: string, now = Date.now()): number {
    this.db.insert(schema.halts).values({ sessionId, createdAt: now }).onConflictDoNothing().run();
    return this.haltOf(sessionId)!;
  }

  /** When the person stopped the session (epoch ms), if they have and not resumed it since. */
  haltOf(sessionId: string): number | undefined {
    return this.db.select().from(schema.halts).where(eq(schema.halts.sessionId, sessionId)).get()?.createdAt;
  }

  /** The person resumed it. False if it was not stopped. */
  clearHalt(sessionId: string): boolean {
    return this.db.delete(schema.halts).where(eq(schema.halts.sessionId, sessionId)).run().changes > 0;
  }

  // ── artifacts ────────────────────────────────────────────────────────

  /** The person accepted an artifact (see `artifactReviews`); accepting it again moves the time on. */
  acceptArtifact(roundUpId: string, key: string, now = Date.now()): number {
    this.db
      .insert(schema.artifactReviews)
      .values({ roundUpId, key, acceptedAt: now })
      .onConflictDoUpdate({ target: [schema.artifactReviews.roundUpId, schema.artifactReviews.key], set: { acceptedAt: now } })
      .run();
    return now;
  }

  /** Every artifact of the round-up the person accepted, by key, with when (epoch ms). */
  acceptedArtifacts(roundUpId: string): Map<string, number> {
    const rows = this.db.select().from(schema.artifactReviews).where(eq(schema.artifactReviews.roundUpId, roundUpId)).all();
    return new Map(rows.map((r) => [r.key, r.acceptedAt]));
  }

  /**
   * The latest successful edit or write (`file.changed`) of each file under `dir` by any of these
   * sessions, of only files ending in one of `extensions` (`.md`) when given: who last wrote it,
   * and when (the event's ISO time). Of writes at the same time, the one logged last wins.
   */
  lastWritesUnder(sessionIds: string[], dir: string, extensions: readonly string[] = []): { path: string; sessionId: string; ts: string }[] {
    if (!sessionIds.length) return [];
    const path = sql<string>`json_extract(${schema.events.event}, '$.data.path')`;
    const ts = sql<string>`json_extract(${schema.events.event}, '$.ts')`;
    const prefix = `${dir.replace(/\/+$/, '')}/`;
    const ofKind = extensions.length ? or(...extensions.map((e) => sql`lower(${path}) like ${`%${e.toLowerCase()}`}`)) : undefined;
    const rows = this.db
      .select({ sessionId: schema.events.sessionId, path, ts })
      .from(schema.events)
      .where(and(inArray(schema.events.sessionId, sessionIds), eq(schema.events.kind, 'file.changed'), sql`substr(${path}, 1, ${prefix.length}) = ${prefix}`, ofKind))
      .orderBy(asc(ts), asc(sql`${schema.events}.rowid`))
      .all();
    const latest = new Map<string, { path: string; sessionId: string; ts: string }>();
    for (const r of rows) latest.set(r.path, r);
    return [...latest.values()];
  }

  close(): void {
    this.sqlite.close();
  }
}

const cardOf = (row: typeof schema.workbenchCards.$inferSelect): CardRow => ({ ...row, tickets: JSON.parse(row.tickets) as unknown[] });
const entryOf = (row: typeof schema.workbenchEntries.$inferSelect): EntryRow => ({ ...row, claims: JSON.parse(row.claims) as string[] });

/** Opens (creating if needed) the store at `path`, or an in-memory one for ':memory:', and migrates it. */
export function openStore(path: string, opts: StoreOptions = {}): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  return new Store(new Database(path), opts);
}
