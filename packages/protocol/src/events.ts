import { z } from 'zod';

/**
 * Kelpie Event Format (KEF): the single shape every harness stream is
 * normalized into. The UI renders it and the orchestrator reasons over it,
 * so neither needs to know which CLI produced an event.
 */

export const Harness = z.enum(['claude-code']);
export type Harness = z.infer<typeof Harness>;

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
