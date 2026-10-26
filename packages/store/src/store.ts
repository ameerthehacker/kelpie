import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { HarnessUsage, KelpieEvent, type EventData, type EventKind, type EventOf, type TicketLink } from '@kelpie/protocol';
import * as schema from './schema.js';

export type SessionRow = typeof schema.sessions.$inferSelect;
export type NewSession = Omit<typeof schema.sessions.$inferInsert, 'createdAt' | 'updatedAt'>;
export type SessionPatch = Partial<Pick<SessionRow, 'title' | 'model' | 'harnessSessionId' | 'resumePending' | 'notifiedIdx' | 'baseBranch' | 'baseCommit' | 'mode'>>;
export type WorktreeRow = typeof schema.worktrees.$inferSelect;
export type NewWorktree = Omit<typeof schema.worktrees.$inferInsert, 'id' | 'createdAt' | 'lastUsedAt' | 'state'>;
export type WorktreePatch = Partial<Pick<WorktreeRow, 'state' | 'lastUsedAt' | 'removedAt' | 'forkCommit'>>;
export type OutboxRow = typeof schema.outbox.$inferSelect;
export type OutboxSource = OutboxRow['source'];
export type AttachmentRow = typeof schema.attachments.$inferSelect;
export type NewAttachment = Omit<AttachmentRow, 'createdAt'>;
export type PermissionRuleRow = typeof schema.permissionRules.$inferSelect;
export interface ConnectionRow extends Omit<typeof schema.connections.$inferSelect, 'scopes'> {
  scopes: string[] | null;
}
export type NewConnection = Omit<ConnectionRow, 'createdAt' | 'updatedAt'>;
export type TicketRow = typeof schema.tickets.$inferSelect;
export type TicketSource = TicketRow['source'];

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

  /** Removes one of a round-up's rules; false if it has no such rule. */
  deleteRule(roundUpId: string, id: number): boolean {
    return this.db.delete(schema.permissionRules).where(and(eq(schema.permissionRules.id, id), eq(schema.permissionRules.roundUpId, roundUpId))).run().changes > 0;
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

  /**
   * Links a ticket to a round-up, once: linking one it has (by `ref`, whatever form the link
   * took) only sets its title, if one is given. True if anything changed.
   */
  linkTicket(roundUpId: string, t: TicketLink, source: TicketSource, title?: string, now = Date.now()): boolean {
    const name = title?.trim() || null;
    return this.atomically(() => {
      const added = this.db
        .insert(schema.tickets)
        .values({ roundUpId, ref: t.ref, provider: t.provider, kind: t.kind, url: t.url, key: t.key ?? null, title: name, source, createdAt: now })
        .onConflictDoNothing()
        .run().changes;
      if (added || !name) return added > 0;
      const where = and(eq(schema.tickets.roundUpId, roundUpId), eq(schema.tickets.ref, t.ref), sql`${schema.tickets.title} is not ${name}`);
      return this.db.update(schema.tickets).set({ title: name }).where(where).run().changes > 0;
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

  close(): void {
    this.sqlite.close();
  }
}

/** Opens (creating if needed) the store at `path`, or an in-memory one for ':memory:', and migrates it. */
export function openStore(path: string, opts: StoreOptions = {}): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  return new Store(new Database(path), opts);
}
