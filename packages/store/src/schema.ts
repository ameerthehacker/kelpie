import { sql } from 'drizzle-orm';
import { type AnySQLiteColumn, index, integer, primaryKey, sqliteTable, text, unique, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  /** A sub-agent given the Claude in Chrome tools, to drive the person's own browser. */
  browser: integer('browser', { mode: 'boolean' }).notNull().default(false),
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
  /** A sub-agent's job: ordinary work, or Muster (bringing other agents' branches together). */
  kind: text('kind', { enum: ['worker', 'muster'] }).notNull().default('worker'),
  /**
   * An orchestrator's base branch, as the person chose it (e.g. `origin/main`), and the commit
   * it was pinned to. Its feature branch starts there; never from whatever the checkout is on.
   */
  baseBranch: text('base_branch'),
  baseCommit: text('base_commit'),
  /** A top-level round-up's mode, as the person picked it; its agents follow it. */
  mode: text('mode', { enum: ['auto', 'acceptEdits', 'plan'] }).notNull().default('auto'),
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
    /** Extra `message` data (JSON) the logged echo of this turn carries, e.g. a notification's agents. */
    meta: text('meta'),
    createdAt: integer('created_at').notNull(),
    /** Set once taken in, or once dropped because the process that should have read it died. */
    deliveredAt: integer('delivered_at'),
  },
  (t) => [index('outbox_pending_idx').on(t.sessionId, t.deliveredAt, t.id)],
);

/**
 * Git worktrees Kelpie made: an orchestrator's home (its feature branch) and one per writing
 * agent. Written before `git worktree add` runs, so a crash mid-way is found and cleaned up.
 * A session's worktree path never changes (harness sessions resume by directory), so a removed
 * worktree is recreated at the same path when its session runs again.
 */
export const worktrees = sqliteTable(
  'worktrees',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The orchestrator round-up it belongs to. */
    roundUpId: text('round_up_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** The session that works in it: the orchestrator for home, else the agent. */
    sessionId: text('session_id')
      .notNull()
      .unique()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['home', 'agent'] }).notNull(),
    repoRoot: text('repo_root').notNull(),
    path: text('path').notNull().unique(),
    branch: text('branch').notNull(),
    /** The branch it was cut from: the base for home, home's branch for an agent. */
    parentBranch: text('parent_branch').notNull(),
    baseBranch: text('base_branch').notNull(),
    baseCommit: text('base_commit').notNull(),
    /** Where its branch was cut: its own work is `forkCommit..branch`. Empty on rows from before it was recorded. */
    forkCommit: text('fork_commit').notNull().default(''),
    /** For an agent's: merged into home by Muster, or a piece that stands alone. */
    deliver: text('deliver', { enum: ['muster', 'standalone'] }),
    state: text('state', { enum: ['creating', 'active', 'mustered', 'removed'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at').notNull(),
    removedAt: integer('removed_at'),
  },
  (t) => [index('worktrees_round_up_idx').on(t.roundUpId)],
);

/**
 * Files the person uploaded to a round-up (or to one of its agents). They live in the round-up's
 * scratch folder, which its orchestrator and agents can read; the row says where and what.
 */
export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    /** The top-level round-up whose scratch folder holds it. */
    roundUpId: text('round_up_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    /** Absolute path on disk. */
    path: text('path').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('attachments_round_up_idx').on(t.roundUpId)],
);

/**
 * Permission rules the person allowed for a whole round-up (e.g. `Bash(pnpm install)`), from an
 * approval. Its agents are started with them, and asked-for requests they cover are answered at once.
 */
export const permissionRules = sqliteTable(
  'permission_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    roundUpId: text('round_up_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    rule: text('rule').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [unique('permission_rules_round_up_rule').on(t.roundUpId, t.rule)],
);

/**
 * One writer's branch as it was mustered: what it changed is `forkCommit..tipCommit`. Recorded
 * before the branch is deleted, so the feature's changes can still be put down to the agent.
 */
export const deliveries = sqliteTable(
  'deliveries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    roundUpId: text('round_up_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    harness: text('harness').notNull(),
    branch: text('branch').notNull(),
    forkCommit: text('fork_commit').notNull(),
    tipCommit: text('tip_commit').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('deliveries_round_up_idx').on(t.roundUpId), unique('deliveries_tip').on(t.roundUpId, t.tipCommit)],
);

/** The person's reviews of a round-up's changes: at most one pending (the draft) at a time. */
export const reviews = sqliteTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    roundUpId: text('round_up_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    state: text('state', { enum: ['pending', 'submitted'] }).notNull(),
    verdict: text('verdict', { enum: ['comment', 'request_changes', 'approve'] }),
    body: text('body').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    submittedAt: integer('submitted_at'),
  },
  (t) => [uniqueIndex('reviews_one_pending').on(t.roundUpId).where(sql`state = 'pending'`)],
);

/** A conversation on one line of a diff: the feature's, or one agent's. */
export const reviewThreads = sqliteTable(
  'review_threads',
  {
    id: text('id').primaryKey(),
    roundUpId: text('round_up_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    view: text('view', { enum: ['feature', 'agent'] }).notNull(),
    /** view 'agent': whose diff it was made on. */
    viewSessionId: text('view_session_id').references(() => sessions.id, { onDelete: 'set null' }),
    /** Owner: the agent whose change the line is (null: base code, Muster, unknown). */
    agentId: text('agent_id').references(() => sessions.id, { onDelete: 'set null' }),
    agentTitle: text('agent_title'),
    path: text('path').notNull(),
    side: text('side', { enum: ['additions', 'deletions'] }).notNull(),
    line: integer('line').notNull(),
    commitSha: text('commit_sha').notNull(),
    baseSha: text('base_sha').notNull(),
    lineText: text('line_text').notNull(),
    diffHunk: text('diff_hunk').notNull(),
    /** pending: only in the person's draft; open once submitted; resolved by the person or an agent. */
    status: text('status', { enum: ['pending', 'open', 'resolved'] }).notNull(),
    assignedTo: text('assigned_to').references(() => sessions.id, { onDelete: 'set null' }),
    /** 'person', or the session id of the agent (or orchestrator) that resolved it. */
    resolvedBy: text('resolved_by'),
    resolvedAt: integer('resolved_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('review_threads_round_up_idx').on(t.roundUpId, t.status)],
);

export const reviewComments = sqliteTable(
  'review_comments',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => reviewThreads.id, { onDelete: 'cascade' }),
    roundUpId: text('round_up_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** The review a person's comment belongs to; null for agents' and the orchestrator's. */
    reviewId: text('review_id').references(() => reviews.id, { onDelete: 'cascade' }),
    author: text('author', { enum: ['person', 'orchestrator', 'agent'] }).notNull(),
    authorSessionId: text('author_session_id').references(() => sessions.id, { onDelete: 'set null' }),
    authorTitle: text('author_title'),
    body: text('body').notNull(),
    state: text('state', { enum: ['pending', 'published'] }).notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('review_comments_thread_idx').on(t.threadId, t.createdAt)],
);
