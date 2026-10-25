import type { EventData, EventKind, KelpieEvent, TodoItem, UsageWindow } from '@kelpie/protocol';
import { applyTodoTool, fileDelta, flattenContent, toolCategory, toolTitle } from './tools.js';

type Obj = Record<string, any>;

const OUTPUT_LIMIT = 4096;

/** High-volume CLI chatter with no value downstream. Still kept in raw.jsonl. */
const IGNORED_SYSTEM = new Set(['thinking_tokens', 'commands_changed']);

/** Written into the transcript by the CLI on interrupt; also "... by user for tool use]". */
const INTERRUPT_MARKER = '[Request interrupted by user';

export interface ParserOptions {
  runId: string;
  /** Clock, injectable so fixture snapshots are deterministic. */
  now?: () => string;
}

interface PendingTool {
  name: string;
  input: Obj;
}

export interface EmitExtra {
  parentCallId?: string | undefined;
  rawLine?: number | undefined;
}

/**
 * Stateful translator from `claude -p --output-format stream-json` lines to
 * KEF events. Pure apart from its own state: no I/O, so fixtures can be
 * replayed through it directly.
 */
export class ClaudeCodeParser {
  readonly runId: string;
  private readonly now: () => string;
  private seq = 0;
  private cwd: string | undefined;
  private sessionId: string | undefined;
  private interrupted = false;
  /** The CLI reports cost cumulatively per process; KEF reports it per turn. */
  private costSoFar = 0;
  private readonly pending = new Map<string, PendingTool>();
  /** The session's todo list. The CLI keeps one per session; sub-agents do not get the todo tools. */
  private todos: TodoItem[] = [];
  /** Turns sent on stdin that the CLI has not yet taken in (it replays each one as it does). */
  private unconsumed = 0;
  private inTurn = false;
  private lastBusy = false;
  /** The latest assistant text: what a plan put to the person says, when ExitPlanMode carries none. */
  private lastText = '';
  /** Permission requests waiting for an answer, with the input they asked about. */
  private readonly permissions = new Map<string, Obj>();

  constructor(opts: ParserOptions) {
    this.runId = opts.runId;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  get harnessSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Builds the next event in this run's sequence. Also used for synthetic events (sent messages, exits). */
  emit<K extends EventKind>(kind: K, data: EventData<K>, extra: EmitExtra = {}): KelpieEvent {
    const seq = this.seq++;
    const ev: Obj = { id: `${this.runId}:${seq}`, runId: this.runId, seq, ts: this.now(), harness: 'claude-code', kind, data };
    if (extra.parentCallId) ev.parentCallId = extra.parentCallId;
    if (extra.rawLine) ev.rawLine = extra.rawLine;
    return ev as KelpieEvent;
  }

  /**
   * True while the harness is working or has turns queued. Turns are not 1:1
   * with sends: the CLI merges messages queued mid-turn into the running turn,
   * and starts turns on its own when a background sub-agent finishes.
   */
  get busy(): boolean {
    return this.unconsumed > 0 || this.inTurn;
  }

  /** Records a turn written to stdin; it counts as queued until the CLI replays it. */
  noteSent(): KelpieEvent[] {
    this.unconsumed++;
    return this.activity();
  }

  /** The process is gone: nothing is running or queued any more, and nothing still asking will be answered. */
  noteExited(): KelpieEvent[] {
    this.unconsumed = 0;
    this.inTurn = false;
    const expired = [...this.permissions.keys()].map((requestId) => this.emit('permission.resolved', { requestId, decision: 'deny', by: 'expired' }));
    this.permissions.clear();
    return [...expired, ...this.activity()];
  }

  /** The input a still-open permission request asked about; undefined once it is answered or gone. */
  permissionInput(requestId: string): Obj | undefined {
    return this.permissions.get(requestId);
  }

  /** A permission request has been answered (by the spawner, on stdin). */
  noteAnswered(requestId: string, data: Omit<EventData<'permission.resolved'>, 'requestId'>): KelpieEvent[] {
    if (!this.permissions.delete(requestId)) return [];
    return [this.emit('permission.resolved', { requestId, ...data })];
  }

  parse(o: Obj, rawLine?: number): KelpieEvent[] {
    if (o.type === 'assistant' || o.type === 'user') this.inTurn = true;
    const out = this.translate(o, rawLine);
    return out.concat(this.activity(rawLine));
  }

  /** An `activity` event when busy has flipped, so consumers see it in order with everything else. */
  private activity(rawLine?: number): KelpieEvent[] {
    const busy = this.busy;
    if (busy === this.lastBusy) return [];
    this.lastBusy = busy;
    return [this.emit('activity', { busy }, { rawLine })];
  }

  private translate(o: Obj, rawLine?: number): KelpieEvent[] {
    const parentCallId: string | undefined = o.parent_tool_use_id ?? undefined;
    const x: EmitExtra = { parentCallId, rawLine };

    switch (o.type) {
      case 'system':
        return this.system(o, x);
      case 'assistant':
        return this.assistant(o, x);
      case 'user':
        return this.user(o, x);
      case 'result':
        return this.result(o, x);
      case 'rate_limit_event':
        return [this.rateLimit(o, x)];
      // Answers to our own control requests (and echoes of our answers to its); the spawner consumes these.
      case 'control_response':
        return [];
      case 'control_request':
        return o.request?.subtype === 'can_use_tool' ? this.permission(o, x) : [];
      // The CLI gave up on a request (the turn was interrupted).
      case 'control_cancel_request':
        return this.noteAnswered(String(o.request_id), { decision: 'deny', by: 'cancelled' });
    }
    return [this.emit('other', { type: String(o.type), raw: o }, x)];
  }

  /** The CLI asking before it uses a tool; the turn waits until the spawner answers. */
  private permission(o: Obj, x: EmitExtra): KelpieEvent[] {
    const req: Obj = o.request;
    const requestId = String(o.request_id);
    const tool = String(req.tool_name ?? '');
    const input: Obj = req.input ?? {};
    this.permissions.set(requestId, input);
    const rule = suggestedRule(req.permission_suggestions);
    // The plan is in the call, or (when the model wrote it out first) its latest message.
    const plan = tool === 'ExitPlanMode' ? (typeof input.plan === 'string' && input.plan.trim() ? input.plan : this.lastText) || undefined : undefined;
    const title = tool === 'ExitPlanMode' ? 'Approve the plan' : toolTitle(tool, input, this.cwd) || String(req.description ?? tool);
    return [this.emit('permission.requested', { requestId, tool, title, input, ...(rule ? { rule } : {}), ...(plan ? { plan } : {}) }, x)];
  }

  private system(o: Obj, x: EmitExtra): KelpieEvent[] {
    if (o.subtype === 'init') {
      // The CLI re-sends init at the start of every turn; only a new session is news.
      if (o.session_id === this.sessionId) return [];
      this.sessionId = o.session_id;
      this.cwd = o.cwd;
      return [
        this.emit(
          'session.started',
          {
            harnessSessionId: String(o.session_id),
            model: String(o.model ?? ''),
            cwd: String(o.cwd ?? ''),
            tools: Array.isArray(o.tools) ? o.tools.map(String) : [],
            ...(o.permissionMode ? { permissionMode: String(o.permissionMode) } : {}),
            ...(o.claude_code_version ? { harnessVersion: String(o.claude_code_version) } : {}),
          },
          x,
        ),
      ];
    }
    if (IGNORED_SYSTEM.has(o.subtype)) return [];
    return [this.emit('other', { type: `system.${o.subtype}`, raw: o }, x)];
  }

  private assistant(o: Obj, x: EmitExtra): KelpieEvent[] {
    const out: KelpieEvent[] = [];
    for (const block of blocks(o.message?.content)) {
      switch (block.type) {
        case 'text':
          if (block.text) {
            if (!x.parentCallId) this.lastText = String(block.text);
            out.push(this.emit('message', { role: 'assistant', text: String(block.text) }, x));
          }
          break;
        case 'thinking':
        case 'redacted_thinking': {
          const text = String(block.thinking ?? '');
          out.push(this.emit('thinking', { text, redacted: text.length === 0 }, x));
          break;
        }
        case 'tool_use': {
          const name = String(block.name);
          const input: Obj = block.input ?? {};
          this.pending.set(block.id, { name, input });
          out.push(
            this.emit(
              'tool.started',
              { callId: String(block.id), name, category: toolCategory(name), title: toolTitle(name, input, this.cwd), input },
              x,
            ),
          );
          break;
        }
        default:
          out.push(this.emit('other', { type: `assistant.${block.type}`, raw: block }, x));
      }
    }
    return out;
  }

  private user(o: Obj, x: EmitExtra): KelpieEvent[] {
    // A replay is one of our stdin turns being taken in; other user text is a sub-agent's prompt.
    if (o.isReplay) this.unconsumed = Math.max(0, this.unconsumed - 1);
    const out: KelpieEvent[] = [];
    for (const block of blocks(o.message?.content)) {
      if (block.type === 'tool_result') {
        out.push(...this.toolResult(block, o.tool_use_result, x));
      } else if (block.type === 'text') {
        const text = String(block.text ?? '');
        if (text.startsWith(INTERRUPT_MARKER)) {
          this.interrupted = true;
          continue;
        }
        if (text) out.push(this.emit('message', { role: 'user', text, ...(o.isReplay ? { sent: true } : {}) }, x));
      } else {
        out.push(this.emit('other', { type: `user.${block.type}`, raw: block }, x));
      }
    }
    return out;
  }

  private toolResult(block: Obj, result: unknown, x: EmitExtra): KelpieEvent[] {
    const callId = String(block.tool_use_id);
    const call = this.pending.get(callId);
    this.pending.delete(callId);
    const name = call?.name ?? 'unknown';
    const ok = block.is_error !== true;
    const full = flattenContent(block.content);
    const truncated = full.length > OUTPUT_LIMIT;
    const out = [this.emit('tool.finished', { callId, name, ok, output: truncated ? full.slice(0, OUTPUT_LIMIT) : full, truncated }, x)];
    if (!ok || !call) return out;

    const res = result && typeof result === 'object' ? (result as Obj) : undefined;
    const delta = fileDelta(name, call.input, res);
    if (delta) out.push(this.emit('file.changed', { callId, ...delta }, x));

    const next = applyTodoTool(name, call.input, res, this.todos);
    if (next) {
      this.todos = next;
      out.push(this.emit('todos', { items: next }, x));
    }
    return out;
  }

  private result(o: Obj, x: EmitExtra): KelpieEvent[] {
    this.inTurn = false;
    // A plan put to the person next turn must not fall back on this turn's words.
    this.lastText = '';
    const u: Obj = o.usage ?? {};
    let costUsd: number | undefined;
    if (typeof o.total_cost_usd === 'number') {
      costUsd = Math.max(0, o.total_cost_usd - this.costSoFar);
      // Aborted turns report 0; never move the baseline backwards or the next turn is charged twice.
      this.costSoFar = Math.max(this.costSoFar, o.total_cost_usd);
    }
    const usage = this.emit(
      'usage',
      {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        ...(costUsd !== undefined ? { costUsd } : {}),
      },
      x,
    );

    const interrupted = this.interrupted || String(o.terminal_reason ?? '').startsWith('aborted');
    this.interrupted = false;
    const success = o.subtype === 'success' && o.is_error !== true;
    const status = success ? 'completed' : interrupted ? 'interrupted' : 'failed';
    const error =
      status === 'failed'
        ? (Array.isArray(o.errors) && o.errors.length ? o.errors.join('; ') : String(o.result ?? o.subtype ?? 'unknown error'))
        : undefined;
    const ended = this.emit(
      'turn.ended',
      {
        status,
        ...(typeof o.result === 'string' && success ? { resultText: o.result } : {}),
        ...(error ? { error } : {}),
        ...(typeof o.duration_ms === 'number' ? { durationMs: o.duration_ms } : {}),
        ...(typeof o.num_turns === 'number' ? { numTurns: o.num_turns } : {}),
      },
      x,
    );
    return [usage, ended];
  }

  private rateLimit(o: Obj, x: EmitExtra): KelpieEvent {
    const info: Obj = o.rate_limit_info ?? {};
    const window: string | undefined = info.rateLimitType;
    const util = window ? info.unifiedWindows?.[window]?.utilization : undefined;
    const windows: Record<string, UsageWindow> = {};
    for (const [name, w] of Object.entries<Obj>(info.unifiedWindows ?? {})) {
      if (typeof w?.utilization === 'number' && typeof w.resetsAt === 'number') {
        windows[name] = { utilization: w.utilization, resetsAt: epochToIso(w.resetsAt) };
      }
    }
    return this.emit(
      'rate_limit',
      {
        status: String(info.status ?? 'unknown'),
        ...(window ? { window } : {}),
        ...(typeof info.resetsAt === 'number' ? { resetsAt: epochToIso(info.resetsAt) } : {}),
        ...(typeof util === 'number' ? { utilization: util } : {}),
        ...(Object.keys(windows).length ? { windows } : {}),
      },
      x,
    );
  }
}

const epochToIso = (seconds: number) => new Date(seconds * 1000).toISOString();

/**
 * The rule the CLI suggests for allowing a request, as a permission rule string: `Bash(pnpm install)`,
 * `WebSearch`. Only when it suggests exactly one: a compound command (`a && b`) gets a rule per part,
 * and allowing it by any one of them would let the rest through unseen.
 */
export function suggestedRule(suggestions: unknown): string | undefined {
  if (!Array.isArray(suggestions)) return undefined;
  const rules = (suggestions as Obj[])
    .filter((s) => s?.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules))
    .flatMap((s) => s.rules as Obj[]);
  const r = rules.length === 1 ? rules[0] : undefined;
  return typeof r?.toolName === 'string' ? (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName) : undefined;
}

function blocks(content: unknown): Obj[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}
