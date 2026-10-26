import type { TodoItem, ToolCategory, UsageLimitPause } from '@kelpie/protocol';

/** A sub-agent at a glance (mirrors the daemon's `AgentSummary`). */
export interface AgentSummary {
  id: string;
  parentId: string;
  title: string;
  harness: string;
  model?: string;
  writes: boolean;
  /** Given the Claude in Chrome tools: it may drive the person's own browser. */
  browser: boolean;
  status: AgentStatus;
  now: string;
  /** When `now` is a tool call: which tool (absent from older daemons). */
  nowTool?: { name: string; category: ToolCategory };
  todos: TodoItem[];
  /** Ordinary work, or Muster. */
  kind?: 'worker' | 'muster';
  /** A writer's own branch, whether it is to be mustered or standalone, and its worktree's state. */
  branch?: string;
  deliver?: 'muster' | 'standalone';
  worktree?: 'creating' | 'active' | 'mustered' | 'removed';
  /** While `paused`: stopped at the usage limit, and when Kelpie resumes it. */
  limited?: UsageLimitPause;
  createdAt: number;
  updatedAt: number;
}

/** `needs-approval`: working, but waiting on the person to allow something. `paused`: stopped at the usage limit until it resets. */
export type AgentStatus = 'working' | 'needs-approval' | 'paused' | 'done' | 'failed' | 'stopped' | 'idle';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'Working',
  'needs-approval': 'Needs you',
  paused: 'Paused',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  idle: 'Idle',
};

/** Pane order: what needs attention first. */
export const STATUS_ORDER: AgentStatus[] = ['needs-approval', 'failed', 'working', 'paused', 'stopped', 'idle', 'done'];
const RANK = Object.fromEntries(STATUS_ORDER.map((s, i) => [s, i])) as Record<AgentStatus, number>;
export const byAttention = (a: AgentSummary, b: AgentSummary) => RANK[a.status] - RANK[b.status] || a.createdAt - b.createdAt;


/** "45s", "8m", "1h 5m": how long an agent has been at it. */
export function elapsed(a: Pick<AgentSummary, 'createdAt' | 'updatedAt' | 'status'>, now: number): string {
  const ms = Math.max(0, (a.status === 'working' || a.status === 'needs-approval' ? now : a.updatedAt) - a.createdAt);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
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
