import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { KelpieEvent, type EventKind, type EventOf } from '@kelpie/protocol';
import * as schema from './schema.js';

export type SessionRow = typeof schema.sessions.$inferSelect;
export type NewSession = Omit<typeof schema.sessions.$inferInsert, 'createdAt' | 'updatedAt'>;
export type SessionPatch = Partial<Pick<SessionRow, 'title' | 'model' | 'harnessSessionId'>>;

const MIGRATIONS = join(import.meta.dirname, '../drizzle');

/**
 * Kelpie's persistent state: round-ups and their event logs. Synchronous, like
 * better-sqlite3 underneath, so a write is done by the time the call returns.
 */
export class Store {
  private readonly db: BetterSQLite3Database<typeof schema>;

  constructor(private readonly sqlite: Database.Database) {
    sqlite.pragma('journal_mode = WAL');
    // Safe with WAL (no corruption); a power cut may lose the last commits. Without it every
    // streamed event would fsync on the event loop.
    sqlite.pragma('synchronous = NORMAL');
    sqlite.pragma('foreign_keys = ON');
    this.db = drizzle(sqlite, { schema });
    migrate(this.db, { migrationsFolder: MIGRATIONS });
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

  updateSession(id: string, patch: SessionPatch): SessionRow | undefined {
    return this.db.update(schema.sessions).set(patch).where(eq(schema.sessions.id, id)).returning().get();
  }

  /** Removes the round-up and, by cascade, its events. */
  deleteSession(id: string): boolean {
    return this.db.delete(schema.sessions).where(eq(schema.sessions.id, id)).run().changes > 0;
  }

  appendEvent(sessionId: string, idx: number, event: KelpieEvent, now = Date.now()): void {
    this.db.transaction((tx) => {
      tx.insert(schema.events).values({ sessionId, idx, kind: event.kind, event: JSON.stringify(event) }).run();
      tx.update(schema.sessions).set({ updatedAt: now }).where(eq(schema.sessions.id, sessionId)).run();
    });
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

  eventCount(sessionId: string): number {
    return this.db.select({ n: sql<number>`count(*)` }).from(schema.events).where(eq(schema.events.sessionId, sessionId)).get()?.n ?? 0;
  }

  close(): void {
    this.sqlite.close();
  }
}

/** Opens (creating if needed) the store at `path`, or an in-memory one for ':memory:', and migrates it. */
export function openStore(path: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  return new Store(new Database(path));
}
