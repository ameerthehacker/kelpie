import { type AnySQLiteColumn, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * A round-up: one conversation with a harness, across however many processes it takes.
 * Top-level round-ups are orchestrators; the sub-agents they spawn are child round-ups.
 */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  /** The orchestrator that spawned this sub-agent; null for a top-level round-up. */
  parentId: text('parent_id').references((): AnySQLiteColumn => sessions.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['orchestrator', 'agent'] }).notNull().default('orchestrator'),
  /** A sub-agent allowed to change files (at most one is busy per cwd). */
  writes: integer('writes', { mode: 'boolean' }).notNull().default(false),
  /** It was working when Kelpie stopped; the next daemon start resumes it. */
  resumePending: integer('resume_pending', { mode: 'boolean' }).notNull().default(false),
  /** A sub-agent's log index up to which its orchestrator has been told it went idle. */
  notifiedIdx: integer('notified_idx').notNull().default(-1),
  title: text('title').notNull().default(''),
  cwd: text('cwd').notNull(),
  harness: text('harness').notNull().default('claude-code'),
  model: text('model'),
  /** The harness's own session id, used to resume it in a new process. */
  harnessSessionId: text('harness_session_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** A round-up's KEF log. `idx` is the event's position in it, which is also its SSE id. */
export const events = sqliteTable(
  'events',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    kind: text('kind').notNull(),
    /** The whole KEF event as JSON. */
    event: text('event').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.idx] }), index('events_kind_idx').on(t.sessionId, t.kind, t.idx)],
);

/** Each harness's latest subscription usage, as it last reported it. Harnesses only report during a turn. */
export const harnessUsage = sqliteTable('harness_usage', {
  harness: text('harness').primaryKey(),
  /** The `rate_limit` event's data, as JSON. */
  usage: text('usage').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Turns sent to a round-up, written before they reach the harness. A row is delivered once
 * the harness echoes the turn back (and it is logged as a `message`); rows still undelivered
 * when Kelpie stops are sent again on the next start.
 */
export const outbox = sqliteTable(
  'outbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    /** Who sent it: the person, the orchestrator (to a sub-agent), or Kelpie itself (notifications, restarts). */
    source: text('source', { enum: ['user', 'orchestrator', 'kelpie'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    /** Set once taken in, or once dropped because the process that should have read it died. */
    deliveredAt: integer('delivered_at'),
  },
  (t) => [index('outbox_pending_idx').on(t.sessionId, t.deliveredAt, t.id)],
);
