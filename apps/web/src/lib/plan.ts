import { toolStatus, type NameOf } from './activity.js';
import type { AgentSummary } from './agents.js';
import { clock, pausedShort, soonest } from './limits.js';
import { groupCounts, groupRank, planGroup, type PlanGroup } from './status.js';

/** What the plan knows beyond the agents: who waits on a plan or a question, and when the orchestrator last moved (see `planGroup`). */
export interface PlanOpts {
  plans?: ReadonlySet<string>;
  questions?: ReadonlySet<string>;
  nameOf?: NameOf;
  settledAt?: number;
  /** Epoch ms, for when a paused agent resumes. */
  now?: number;
}

/** The groups the collapsed bar gives a dot each: what is moving, stuck on someone, or waiting for the usage limit to reset. */
const TRACKED: PlanGroup[] = ['needs-you', 'failed', 'working', 'paused'];

/** Most urgent first, then oldest first. */
export const byUrgency =
  (settledAt?: number) =>
  (a: AgentSummary, b: AgentSummary): number =>
    groupRank(planGroup(a, settledAt)) - groupRank(planGroup(b, settledAt)) || a.createdAt - b.createdAt;

export interface PlanSections {
  /** Everything not done, most urgent first: shown in full. */
  active: AgentSummary[];
  /** Finished for good, oldest first: folded away. */
  done: AgentSummary[];
}

export function planSections(agents: readonly AgentSummary[], settledAt?: number): PlanSections {
  const sorted = [...agents].sort(byUrgency(settledAt));
  const done = (a: AgentSummary) => planGroup(a, settledAt) === 'done';
  return { active: sorted.filter((a) => !done(a)), done: sorted.filter(done) };
}

/**
 * The tool the agent is using (the daemon's `nowTool`), in plain words: "Running a command",
 * "Reading a.ts". Undefined when `now` is not a tool call (what the agent last said, an error) or
 * the tool has no words of its own, so a raw command never shows.
 */
export function nowAsTool(a: Pick<AgentSummary, 'now' | 'nowTool'>, nameOf?: NameOf): string | undefined {
  const tool = a.nowTool;
  if (!tool || (tool.category === 'other' && tool.name !== 'ExitPlanMode')) return undefined;
  // `now` is the tool's name and what it works on: a path for files, a URL for a fetch.
  const target = a.now.startsWith(`${tool.name} `) ? a.now.slice(tool.name.length + 1).trim() : '';
  const input = tool.category === 'read' || tool.category === 'edit' ? { file_path: target } : tool.name === 'WebFetch' ? { url: target } : {};
  return toolStatus({ name: tool.name, category: tool.category, input }, nameOf);
}

/** The agent's todo in progress, in its present-tense words. */
export function currentTodo(a: Pick<AgentSummary, 'todos'>): string | undefined {
  const t = a.todos.find((t) => t.status === 'in_progress');
  return t && (t.activeText ?? t.text);
}

/**
 * One short line on an agent for the plan: what it needs from the person, or what it is working on
 * (its current todo, else its tool in plain words), or where its work stands. `plans` and
 * `questions` hold the agents waiting on the person to review a plan or answer a question.
 */
export function planLabel(a: AgentSummary, opts: PlanOpts = {}): string {
  switch (planGroup(a, opts.settledAt)) {
    case 'needs-you':
      return opts.plans?.has(a.id) ? 'Plan to review' : opts.questions?.has(a.id) ? 'Has a question' : 'Needs your approval';
    case 'failed':
      return 'Failed';
    case 'working':
      return currentTodo(a) ?? nowAsTool(a, opts.nameOf) ?? 'Working';
    case 'paused':
      return a.limited ? `Usage limit · ${pausedShort(a.limited, opts.now ?? Date.now())}` : 'Paused for usage limit';
    case 'to-merge':
      return 'Ready to merge';
    case 'stopped':
      // A failure the orchestrator has moved on from still says so, calmly.
      return a.status === 'failed' ? 'Failed' : 'Stopped';
    case 'done':
      return a.worktree === 'mustered' ? 'Merged' : a.branch && a.deliver === 'standalone' ? 'Done · standalone branch' : 'Done';
  }
}

export interface PlanBar {
  /** Agents with a dot of their own, most urgent first, with the group their dot shows. */
  dots: { agent: AgentSummary; group: PlanGroup }[];
  /** Tracked agents past the cap: "+N". */
  more: number;
  /** The most urgent agent and its line ("Fix: notifications: Needs your approval"), or a calm summary when nothing is moving. */
  text: string;
  /** Counts that sit at the end of the bar: "3 ready to merge", "14 done". */
  counts: string[];
  /** What the dots stand for, all of them: "1 needs you, 3 working". */
  label: string;
}

export const MAX_DOTS = 5;

/** The collapsed plan: a dot per agent that needs tracking, finished ones as one count. */
export function planBar(agents: readonly AgentSummary[], opts: PlanOpts & { maxDots?: number } = {}): PlanBar {
  const max = opts.maxDots ?? MAX_DOTS;
  const group = (a: AgentSummary) => planGroup(a, opts.settledAt);
  const sorted = [...agents].sort(byUrgency(opts.settledAt));
  const groups = sorted.map(group);
  const tracked = sorted.filter((a) => TRACKED.includes(group(a)));

  if (tracked.length === 0) {
    const count = (g: PlanGroup) => groups.filter((x) => x === g).length;
    const toMerge = count('to-merge');
    const finished = count('done') + toMerge;
    const verb = toMerge ? 'finished' : 'done';
    const all = agents.length === 1 ? `Agent ${verb}` : `All ${agents.length} agents ${verb}`;
    const lead = finished === agents.length ? all : `${finished}/${agents.length} agents finished`;
    return { dots: [], more: 0, text: [lead, ...groupCounts(groups, ['to-merge', 'stopped'])].join(' · '), counts: [], label: '' };
  }

  // The live line follows whoever needs the person, else whoever is working, before what has failed.
  const lead = tracked.find((a) => group(a) === 'needs-you') ?? tracked.find((a) => group(a) === 'working') ?? tracked[0]!;
  // Everything moving waits on the usage limit: when it all picks up again.
  const paused = tracked.every((a) => group(a) === 'paused');
  const resumes = paused ? soonest(tracked.map((a) => a.limited)) : undefined;
  const text = paused
    ? `${tracked.length === 1 ? `${lead.title} is` : `${tracked.length} agents are`} paused for the usage limit${resumes ? ` · resumes ${clock(resumes, opts.now ?? Date.now())}` : ''}`
    : `${lead.title}: ${planLabel(lead, opts)}`;
  return {
    dots: tracked.slice(0, max).map((agent) => ({ agent, group: group(agent) })),
    more: Math.max(0, tracked.length - max),
    text,
    counts: groupCounts(groups, ['to-merge', 'stopped', 'done']),
    label: groupCounts(groups, TRACKED).join(', '),
  };
}
