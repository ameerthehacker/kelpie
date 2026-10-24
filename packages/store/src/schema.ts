import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** A round-up: one conversation with a harness, across however many processes it takes. */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
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
