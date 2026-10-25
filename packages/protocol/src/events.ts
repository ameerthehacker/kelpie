import { z } from 'zod';

/**
 * Kelpie Event Format (KEF): the single shape every harness stream is
 * normalized into. The UI renders it and the orchestrator reasons over it,
 * so neither needs to know which CLI produced an event.
 */

export const Harness = z.enum(['claude-code']);
export type Harness = z.infer<typeof Harness>;

/**
 * How freely a round-up's agents work, as the person picks it: `auto` (nothing asks; the harness
 * blocks what is risky), `acceptEdits` (edits go through, anything else asks first), or `plan`
 * (investigate and plan; no writers). Each harness supports some of them.
 */
export const Mode = z.enum(['auto', 'acceptEdits', 'plan']);
export type Mode = z.infer<typeof Mode>;

/** Coarse tool buckets; these drive the live-log labels in the UI. */
export const ToolCategory = z.enum(['read', 'search', 'edit', 'bash', 'web', 'todo', 'task', 'mcp', 'other']);
export type ToolCategory = z.infer<typeof ToolCategory>;

export const TodoStatus = z.enum(['pending', 'in_progress', 'completed']);
export type TodoStatus = z.infer<typeof TodoStatus>;

export const TodoItem = z.object({
  id: z.string(),
  text: z.string(),
  status: TodoStatus,
  /** Present-tense label for the item while it is in progress ("Running tests"). */
  activeText: z.string().optional(),
});
export type TodoItem = z.infer<typeof TodoItem>;

const envelope = {
  id: z.string(),
  runId: z.string(),
  /** Monotonic per run, starting at 0. */
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  harness: Harness,
  /** Set when the event came from inside a sub-agent; the id of the tool call that spawned it. */
  parentCallId: z.string().optional(),
  /** 1-based line in the run's raw.jsonl this event was derived from. */
  rawLine: z.number().int().positive().optional(),
};

const ev = <K extends string, D extends z.ZodTypeAny>(kind: K, data: D) =>
  z.object({ ...envelope, kind: z.literal(kind), data });

export const SessionStarted = ev(
  'session.started',
  z.object({
    harnessSessionId: z.string(),
    model: z.string(),
    cwd: z.string(),
    tools: z.array(z.string()),
    permissionMode: z.string().optional(),
    harnessVersion: z.string().optional(),
  }),
);

/** One sub-agent in a notification Kelpie sent its orchestrator. */
export const AgentUpdate = z.object({
  agentId: z.string(),
  title: z.string(),
  /** How its last turn ended, or 'not started'. */
  status: z.string(),
  /**
   * Its final message of that turn. On a logged notification only when the text had to cut
   * it: otherwise the text carries it, and it is not stored twice.
   */
  report: z.string().optional(),
  error: z.string().optional(),
  filesChanged: z.array(z.object({ path: z.string(), added: z.number(), removed: z.number() })).optional(),
  /** A writing agent's own branch, and how far it is ahead of the feature branch. */
  branch: z.string().optional(),
  ahead: z.number().optional(),
  diffstat: z.string().optional(),
  deliver: z.enum(['muster', 'standalone']).optional(),
});
export type AgentUpdate = z.infer<typeof AgentUpdate>;

/** A file sent with a turn: uploaded by the person (it has an id), or handed on by the orchestrator. */
export const Attachment = z.object({
  id: z.string().optional(),
  name: z.string(),
  mime: z.string().optional(),
  size: z.number(),
});
export type Attachment = z.infer<typeof Attachment>;

export const Message = ev(
  'message',
  z.object({
    role: z.enum(['assistant', 'user']),
    text: z.string(),
    /** A turn Kelpie sent, as the harness echoed it on taking it in. */
    sent: z.boolean().optional(),
    /**
     * Who a sent turn came from: the person, the orchestrator (to its sub-agent), or Kelpie
     * itself (notifications, restarts). Set by the daemon from its outbox.
     */
    source: z.enum(['user', 'orchestrator', 'kelpie']).optional(),
    /** On a notification Kelpie sent an orchestrator: the sub-agents it covers, for the UI. */
    agents: z.array(AgentUpdate).optional(),
    /** Files sent with the turn; the text lists their paths in an `<attachments>` block. */
    attachments: z.array(Attachment).optional(),
  }),
);

export const Thinking = ev(
  'thinking',
  z.object({
    text: z.string(),
    /** The harness withheld the text (only a signature was sent). */
    redacted: z.boolean(),
  }),
);

export const ToolStarted = ev(
  'tool.started',
  z.object({
    callId: z.string(),
    name: z.string(),
    category: ToolCategory,
    /** One-line human summary: a path, a command, a query. */
    title: z.string(),
    input: z.unknown(),
  }),
);

export const ToolFinished = ev(
  'tool.finished',
  z.object({
    callId: z.string(),
    name: z.string(),
    ok: z.boolean(),
    output: z.string(),
    truncated: z.boolean(),
  }),
);

export const FileChanged = ev(
  'file.changed',
  z.object({
    callId: z.string(),
    path: z.string(),
    op: z.enum(['edit', 'write']),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  }),
);

/** Full snapshot of the agent's todo list after a change. */
export const Todos = ev('todos', z.object({ items: z.array(TodoItem) }));

/** Token and cost totals for one turn. */
export const Usage = ev(
  'usage',
  z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
    costUsd: z.number().optional(),
  }),
);

/** Subscription / plan rate-limit state, so schedulers can back off before hitting a wall. */
export const UsageWindow = z.object({
  /** Fraction of the window's allowance used, 0..1. */
  utilization: z.number(),
  resetsAt: z.string(),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

/**
 * The harness's subscription usage. `window`/`resetsAt`/`utilization` describe the window
 * this report is about; `windows` has every window the harness reported (Claude Code:
 * `five_hour`, `seven_day`).
 */
export const RateLimit = ev(
  'rate_limit',
  z.object({
    status: z.string(),
    window: z.string().optional(),
    resetsAt: z.string().optional(),
    utilization: z.number().optional(),
    windows: z.record(z.string(), UsageWindow).optional(),
  }),
);

/** The harness started or stopped working (a turn running, or sent turns still queued). Emitted on change. */
export const Activity = ev('activity', z.object({ busy: z.boolean() }));

export const TurnEnded = ev(
  'turn.ended',
  z.object({
    status: z.enum(['completed', 'failed', 'interrupted']),
    resultText: z.string().optional(),
    error: z.string().optional(),
    durationMs: z.number().optional(),
    numTurns: z.number().optional(),
  }),
);

export const ProcessExited = ev(
  'process.exited',
  z.object({
    code: z.number().nullable(),
    signal: z.string().nullable(),
    stderrTail: z.string(),
  }),
);

/** Anything the parser does not understand yet. Kept, never dropped. */
export const Other = ev(
  'other',
  z.object({
    type: z.string(),
    raw: z.unknown(),
  }),
);

/**
 * The harness asks before using a tool (accept-edits mode, or anything its rules don't cover). The
 * turn waits until it is answered: by the person, by Kelpie's own rules, or not at all (the process
 * ended or the turn was interrupted).
 */
export const PermissionRequested = ev(
  'permission.requested',
  z.object({
    requestId: z.string(),
    tool: z.string(),
    /** One line on what it wants to do: a command, a path, a URL. */
    title: z.string(),
    input: z.unknown(),
    /**
     * The permission rule that would allow this and requests like it, e.g. `Bash(pnpm install)`, as
     * the harness suggests it. Requests with the same rule are grouped, and answered together.
     */
    rule: z.string().optional(),
    /** For a plan put to the person (ExitPlanMode): the plan, as markdown. */
    plan: z.string().optional(),
  }),
);

export const PermissionResolved = ev(
  'permission.resolved',
  z.object({
    requestId: z.string(),
    decision: z.enum(['allow', 'deny']),
    /** The person; Kelpie's rules (or a rule the person saved); or nobody: the run ended or the turn was cancelled. */
    by: z.enum(['person', 'kelpie', 'expired', 'cancelled']),
    message: z.string().optional(),
  }),
);

export const KelpieEvent = z.discriminatedUnion('kind', [
  SessionStarted,
  Message,
  Thinking,
  ToolStarted,
  ToolFinished,
  FileChanged,
  Todos,
  Usage,
  RateLimit,
  Activity,
  TurnEnded,
  ProcessExited,
  PermissionRequested,
  PermissionResolved,
  Other,
]);
export type KelpieEvent = z.infer<typeof KelpieEvent>;
export type EventKind = KelpieEvent['kind'];
export type EventOf<K extends EventKind> = Extract<KelpieEvent, { kind: K }>;
export type EventData<K extends EventKind> = EventOf<K>['data'];

/** A harness's latest subscription usage, as Kelpie keeps and serves it. */
export const HarnessUsage = z.object({
  harness: Harness,
  usage: RateLimit.shape.data,
  /** Epoch ms of the latest report. */
  updatedAt: z.number(),
});
export type HarnessUsage = z.infer<typeof HarnessUsage>;

/**
 * Folds a new usage report into the previous one: the status (and the window it is about)
 * come from the new report, and windows it does not mention keep their last known figures.
 */
export function mergeUsage(prev: EventData<'rate_limit'> | undefined, next: EventData<'rate_limit'>): EventData<'rate_limit'> {
  const windows = { ...prev?.windows, ...next.windows };
  return { ...next, ...(Object.keys(windows).length ? { windows } : {}) };
}
