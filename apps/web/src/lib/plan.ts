import type { ToolCategory } from '@kelpie/protocol';
import { toolStatus, type NameOf } from './activity.js';
import type { AgentSummary } from './agents.js';

/**
 * Where an agent sits in the plan. `needs-you`: waiting on the person (an approval or a plan).
 * `to-merge`: finished, but its branch still waits to be mustered, so not done yet. `stopped`:
 * interrupted or never finished a turn. Mustered, standalone and read-only agents that finished are `done`.
 */
export type PlanGroup = 'needs-you' | 'failed' | 'working' | 'to-merge' | 'stopped' | 'done';

/** Most urgent first. */
export const GROUP_ORDER: PlanGroup[] = ['needs-you', 'failed', 'working', 'to-merge', 'stopped', 'done'];
const RANK = Object.fromEntries(GROUP_ORDER.map((g, i) => [g, i])) as Record<PlanGroup, number>;

/** The groups the collapsed bar gives a dot each: what is moving, or stuck on someone. */
const TRACKED = new Set<PlanGroup>(['needs-you', 'failed', 'working']);

export function planGroup(a: AgentSummary): PlanGroup {
  switch (a.status) {
    case 'needs-approval':
      return 'needs-you';
    case 'failed':
      return 'failed';
    case 'working':
      return 'working';
    case 'stopped':
    case 'idle':
      return 'stopped';
    case 'done':
      return a.branch && a.kind !== 'muster' && a.deliver !== 'standalone' && a.worktree !== 'mustered' ? 'to-merge' : 'done';
  }
}

export const byUrgency = (a: AgentSummary, b: AgentSummary) => RANK[planGroup(a)] - RANK[planGroup(b)] || a.createdAt - b.createdAt;

export interface PlanSections {
  /** Everything not done, most urgent first: shown in full. */
  active: AgentSummary[];
  /** Finished for good, oldest first: folded away. */
  done: AgentSummary[];
}

export function planSections(agents: readonly AgentSummary[]): PlanSections {
  const sorted = [...agents].sort(byUrgency);
  return { active: sorted.filter((a) => planGroup(a) !== 'done'), done: sorted.filter((a) => planGroup(a) === 'done') };
}

/** Claude Code's tools, by the name the daemon's `now` line starts with (see the adapter's `toolCategory`). */
const TOOLS: Record<string, ToolCategory> = {
  Read: 'read',
  Glob: 'search',
  Grep: 'search',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'bash',
  WebFetch: 'web',
  WebSearch: 'web',
  TodoWrite: 'todo',
  TaskCreate: 'todo',
  TaskUpdate: 'todo',
  TaskList: 'todo',
  TaskGet: 'todo',
  Agent: 'task',
  Task: 'task',
  ExitPlanMode: 'other',
};

/**
 * The daemon's `now` line, when it is a tool call ("Bash sed -n 820,890p …", "Read src/a.ts"), in
 * plain words: "Running a command", "Reading a.ts". Undefined for anything else (what the agent
 * last said, an error), so a raw command never shows.
 */
export function nowAsTool(now: string, nameOf?: NameOf): string | undefined {
  const m = /^(\S+)\s*(.*)$/.exec(now.trim());
  if (!m) return undefined;
  const name = m[1]!;
  const rest = m[2]!;
  const category = name.startsWith('mcp__') ? 'mcp' : TOOLS[name];
  if (!category) return undefined;
  const input = category === 'read' || category === 'edit' ? { file_path: rest } : name === 'WebFetch' ? { url: rest } : {};
  return toolStatus({ name, category, input }, nameOf);
}

/** The agent's todo in progress, in its present-tense words. */
export function currentTodo(a: Pick<AgentSummary, 'todos'>): string | undefined {
  const t = a.todos.find((t) => t.status === 'in_progress');
  return t && (t.activeText ?? t.text);
}

/**
 * One short line on an agent for the plan: what it needs from the person, or what it is working on
 * (its current todo, else its tool in plain words), or where its work stands. `plans` holds the
 * agents waiting on the person to review a plan.
 */
export function planLabel(a: AgentSummary, opts: { plans?: ReadonlySet<string>; nameOf?: NameOf } = {}): string {
  switch (planGroup(a)) {
    case 'needs-you':
      return opts.plans?.has(a.id) ? 'Plan to review' : 'Needs your approval';
    case 'failed':
      return 'Failed';
    case 'working':
      return currentTodo(a) ?? nowAsTool(a.now, opts.nameOf) ?? 'Working';
    case 'to-merge':
      return 'Ready to merge';
    case 'stopped':
      return a.status === 'idle' ? 'Idle' : 'Stopped';
    case 'done':
      return a.worktree === 'mustered' ? 'Merged' : a.branch && a.deliver === 'standalone' ? 'Done · standalone branch' : 'Done';
  }
}

export interface PlanBar {
  /** Agents with a dot of their own, most urgent first. */
  dots: AgentSummary[];
  /** Tracked agents past the cap: "+N". */
  more: number;
  /** The most urgent agent and its line ("Fix: notifications: Needs your approval"), or a calm summary when nothing is moving. */
  text: string;
  /** Counts that sit at the end of the bar: "3 to merge", "14 done". */
  counts: string[];
}

export const MAX_DOTS = 5;

/** The collapsed plan: a dot per agent that needs tracking, finished ones as one count. */
export function planBar(agents: readonly AgentSummary[], opts: { plans?: ReadonlySet<string>; nameOf?: NameOf; maxDots?: number } = {}): PlanBar {
  const max = opts.maxDots ?? MAX_DOTS;
  const sorted = [...agents].sort(byUrgency);
  const tracked = sorted.filter((a) => TRACKED.has(planGroup(a)));
  const count = (g: PlanGroup) => sorted.filter((a) => planGroup(a) === g).length;
  const done = count('done');
  const toMerge = count('to-merge');
  const stopped = count('stopped');

  if (tracked.length === 0) {
    const finished = done + toMerge;
    const lead = finished === agents.length ? `All ${agents.length} agents ${toMerge ? 'finished' : 'done'}` : `${finished}/${agents.length} agents finished`;
    const rest = [toMerge && `${toMerge} ready to merge`, stopped && `${stopped} stopped`].filter((s): s is string => !!s);
    return { dots: [], more: 0, text: [lead, ...rest].join(' · '), counts: [] };
  }

  // The live line follows whoever needs the person, else whoever is working, before what has failed.
  const lead = tracked.find((a) => planGroup(a) === 'needs-you') ?? tracked.find((a) => planGroup(a) === 'working') ?? tracked[0]!;
  return {
    dots: tracked.slice(0, max),
    more: Math.max(0, tracked.length - max),
    text: `${lead.title}: ${planLabel(lead, opts)}`,
    counts: [toMerge && `${toMerge} to merge`, stopped && `${stopped} stopped`, done && `${done} done`].filter((s): s is string => !!s),
  };
}
