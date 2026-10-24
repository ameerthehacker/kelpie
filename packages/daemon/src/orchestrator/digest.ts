import type { KelpieEvent, TodoItem } from '@kelpie/protocol';

/**
 * What the orchestrator reads about a sub-agent: its KEF log boiled down to the report it
 * ended its last turn with, plus the facts Kelpie knows for certain (files, cost, errors).
 */
export interface AgentReport {
  /** The agent's final message of its last finished turn; empty before one has finished. */
  report: string;
  turns: number;
  lastTurn: 'completed' | 'failed' | 'interrupted' | undefined;
  filesChanged: { path: string; added: number; removed: number }[];
  todos: TodoItem[];
  costUsd: number;
  error: string | undefined;
}

const MESSAGE_CHARS = 400;
const ERROR_CHARS = 600;

export function report(events: KelpieEvent[]): AgentReport {
  let text = '';
  let lastAssistant = '';
  let turns = 0;
  let lastTurn: AgentReport['lastTurn'];
  let todos: TodoItem[] = [];
  let costUsd = 0;
  let error: string | undefined;
  const files = new Map<string, { added: number; removed: number }>();

  for (const e of events) {
    switch (e.kind) {
      case 'message':
        // Sub-agent chatter (parentCallId) is not the agent's own answer.
        if (e.data.role === 'assistant' && !e.parentCallId) lastAssistant = e.data.text;
        break;
      case 'turn.ended':
        turns++;
        lastTurn = e.data.status;
        // Only what this turn said: a turn that failed before saying anything has no report.
        text = e.data.resultText || lastAssistant;
        lastAssistant = '';
        error = e.data.status === 'failed' ? e.data.error : undefined;
        break;
      case 'file.changed': {
        const f = files.get(e.data.path) ?? { added: 0, removed: 0 };
        f.added += e.data.added;
        f.removed += e.data.removed;
        files.set(e.data.path, f);
        break;
      }
      case 'todos':
        todos = e.data.items;
        break;
      case 'usage':
        costUsd += e.data.costUsd ?? 0;
        break;
      case 'process.exited':
        if (e.data.code) error = `harness exited with code ${e.data.code}: ${e.data.stderrTail.slice(-ERROR_CHARS)}`.trim();
        break;
    }
  }
  return {
    report: text,
    turns,
    lastTurn,
    filesChanged: [...files].map(([path, f]) => ({ path, ...f })),
    todos,
    costUsd: Math.round(costUsd * 10_000) / 10_000,
    error,
  };
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** One line per event worth reading, or undefined for noise. */
function line(e: KelpieEvent): string | undefined {
  const sub = e.parentCallId ? '  ' : '';
  switch (e.kind) {
    case 'message':
      return `${sub}${e.data.role === 'assistant' ? 'agent' : e.parentCallId ? 'sub-agent prompt' : 'sent'}: ${clip(e.data.text, MESSAGE_CHARS)}`;
    case 'tool.started':
      return `${sub}> ${e.data.name}: ${clip(e.data.title, 160)}`;
    case 'tool.finished':
      return e.data.ok ? undefined : `${sub}x ${e.data.name} failed: ${clip(e.data.output, 200)}`;
    case 'file.changed':
      return `${sub}~ ${e.data.op} ${e.data.path} +${e.data.added} -${e.data.removed}`;
    case 'todos':
      return `todos: ${e.data.items.filter((t) => t.status === 'completed').length}/${e.data.items.length} done`;
    case 'turn.ended':
      return `-- turn ${e.data.status}${e.data.error ? `: ${clip(e.data.error, 200)}` : ''}`;
    case 'process.exited':
      return e.data.code ? `-- process exited ${e.data.code}: ${clip(e.data.stderrTail, 200)}` : undefined;
    default:
      return undefined;
  }
}

export interface LogPage {
  lines: string[];
  /** Pass as `after` to read on from here. */
  nextCursor: number;
  more: boolean;
}

/** The log after index `after`, as compact numbered lines, at most `limit` of them. */
export function logLines(events: KelpieEvent[], after = -1, limit = 60): LogPage {
  const lines: string[] = [];
  let cursor = after;
  for (let i = Math.max(0, after + 1); i < events.length; i++) {
    const l = line(events[i]!);
    if (l !== undefined) {
      if (lines.length === limit) return { lines, nextCursor: cursor, more: true };
      lines.push(`#${i} ${l}`);
    }
    cursor = i;
  }
  return { lines, nextCursor: cursor, more: false };
}
