import { format } from 'date-fns';
import { firstLine, type KelpieEvent, type TodoItem, type ToolCategory } from '@kelpie/protocol';

/** A sub-agent at a glance (mirrors the daemon's `AgentSummary`). */
export interface AgentSummary {
  id: string;
  parentId: string;
  title: string;
  harness: string;
  model?: string;
  writes: boolean;
  status: AgentStatus;
  now: string;
  todos: TodoItem[];
  createdAt: number;
  updatedAt: number;
}

export type AgentStatus = 'working' | 'done' | 'failed' | 'stopped' | 'idle';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'Working',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  idle: 'Idle',
};

/** Pane order: what needs attention first. */
const RANK: Record<AgentStatus, number> = { failed: 0, working: 1, stopped: 2, idle: 3, done: 4 };
export const byAttention = (a: AgentSummary, b: AgentSummary) => RANK[a.status] - RANK[b.status] || a.createdAt - b.createdAt;


/** "45s", "8m", "1h 5m": how long an agent has been at it. */
export function elapsed(a: Pick<AgentSummary, 'createdAt' | 'updatedAt' | 'status'>, now: number): string {
  const ms = Math.max(0, (a.status === 'working' ? now : a.updatedAt) - a.createdAt);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export type LogKind = ToolCategory | 'say' | 'task' | 'you' | 'kelpie' | 'done' | 'fail' | 'stop';

export interface LogLine {
  id: string;
  time: string;
  kind: LogKind;
  text: string;
  /** For an edit: its +/- line counts once known. */
  delta?: { added: number; removed: number };
}

/** An agent's own activity as one line per step (sub-agents it ran are left out). */
export function liveLog(events: readonly KelpieEvent[]): LogLine[] {
  const lines: LogLine[] = [];
  const byCall = new Map<string, LogLine>();
  const push = (e: KelpieEvent, kind: LogKind, text: string) => {
    const line: LogLine = { id: e.id, time: format(new Date(e.ts), 'HH:mm'), kind, text };
    lines.push(line);
    return line;
  };
  for (const e of events) {
    if (e.parentCallId) continue;
    switch (e.kind) {
      case 'tool.started':
        if (e.data.category !== 'todo') byCall.set(e.data.callId, push(e, e.data.category, e.data.title || e.data.name));
        break;
      case 'tool.finished':
        if (!e.data.ok && byCall.has(e.data.callId)) push(e, 'fail', `${e.data.name} failed: ${firstLine(e.data.output)}`);
        break;
      case 'file.changed': {
        const line = byCall.get(e.data.callId);
        if (line) line.delta = { added: e.data.added, removed: e.data.removed };
        break;
      }
      case 'message':
        if (e.data.role === 'assistant') push(e, 'say', firstLine(e.data.text));
        else if (e.data.sent) push(e, e.data.source === 'orchestrator' ? 'task' : e.data.source === 'kelpie' ? 'kelpie' : 'you', firstLine(e.data.text));
        break;
      case 'turn.ended':
        if (e.data.status === 'completed') push(e, 'done', 'Turn finished');
        else if (e.data.status === 'failed') push(e, 'fail', e.data.error ?? 'Turn failed');
        else push(e, 'stop', 'Stopped');
        break;
    }
  }
  return lines;
}

export interface PlanProgress {
  agents: number;
  agentsDone: number;
  steps: number;
  stepsDone: number;
}

/** The round-up's plan at a glance: agents finished, and their todos ticked off. */
export function planProgress(agents: readonly AgentSummary[]): PlanProgress {
  let steps = 0;
  let stepsDone = 0;
  for (const a of agents) {
    steps += a.todos.length;
    stepsDone += a.todos.filter((t) => t.status === 'completed').length;
  }
  return { agents: agents.length, agentsDone: agents.filter((a) => a.status === 'done').length, steps, stepsDone };
}
