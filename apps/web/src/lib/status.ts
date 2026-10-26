import type { AgentStatus, AgentSummary } from './agents.js';
import type { PendingApproval } from './approvals.js';
import type { RoundUp } from './round-ups.js';

/**
 * Where an agent sits in the plan, and so what its round-up's dot shows. `needs-you`: waiting on
 * the person (an approval, a question or a plan). `to-merge`: finished, but its branch still waits
 * to be mustered, so not done yet. `paused`: stopped at the usage limit, until Kelpie resumes it after the
 * reset (not a failure). `stopped`: interrupted, never finished a turn, or failed in a way the
 * orchestrator has since moved on from. Mustered, standalone and read-only agents that finished are `done`.
 */
export type PlanGroup = 'needs-you' | 'failed' | 'working' | 'paused' | 'to-merge' | 'stopped' | 'done';

/** Most urgent first. */
export const GROUP_ORDER: PlanGroup[] = ['needs-you', 'failed', 'working', 'paused', 'to-merge', 'stopped', 'done'];
const RANK = Object.fromEntries(GROUP_ORDER.map((g, i) => [g, i])) as Record<PlanGroup, number>;
export const groupRank = (g: PlanGroup) => RANK[g];

/** What each group is called, wherever a status shows: the round-up's dot, the Plan bar, the sidebar. */
export const GROUP_LABEL: Record<PlanGroup, string> = {
  'needs-you': 'Needs you',
  failed: 'Failed',
  working: 'Working',
  paused: 'Paused',
  'to-merge': 'Ready to merge',
  stopped: 'Stopped',
  done: 'Done',
};

/** "1 needs you", "3 working", "2 ready to merge". */
const counted = (g: PlanGroup, n: number) => (g === 'needs-you' ? `${n} need${n === 1 ? 's' : ''} you` : `${n} ${GROUP_LABEL[g].toLowerCase()}`);

/** Each of `groups` that some agent is in, as counts, most urgent first: ["1 needs you", "3 working"]. */
export function groupCounts(of: readonly PlanGroup[], groups: readonly PlanGroup[] = GROUP_ORDER): string[] {
  return groups.flatMap((g) => {
    const n = of.filter((x) => x === g).length;
    return n ? [counted(g, n)] : [];
  });
}

/** What the group is read from: an AgentSummary has it all, and so does a sub-agent's session info (see `sessionAgent`). */
export type Placed = Pick<AgentSummary, 'status' | 'updatedAt' | 'branch' | 'kind' | 'deliver' | 'worktree'>;

/**
 * An agent's group. `settledAt`, its orchestrator's last activity: a failure from before it is one
 * the orchestrator has had a turn since (and retried, or told the person about), so it no longer
 * stands out as failed.
 */
export function planGroup(a: Placed, settledAt?: number): PlanGroup {
  switch (a.status) {
    case 'needs-approval':
      return 'needs-you';
    case 'failed':
      return settledAt !== undefined && a.updatedAt <= settledAt ? 'stopped' : 'failed';
    case 'working':
      return 'working';
    case 'paused':
      return 'paused';
    case 'stopped':
    case 'idle':
      return 'stopped';
    case 'done':
      return a.branch && a.kind !== 'muster' && a.deliver !== 'standalone' && a.worktree !== 'mustered' ? 'to-merge' : 'done';
  }
}

/** The most urgent of `groups`, if any. */
export const mostUrgent = (groups: Iterable<PlanGroup>): PlanGroup | undefined => {
  let top: PlanGroup | undefined;
  for (const g of groups) if (!top || RANK[g] < RANK[top]) top = g;
  return top;
};

type StatusSession = Pick<RoundUp, 'id' | 'busy' | 'lastTurn' | 'parentId' | 'updatedAt' | 'kind' | 'branch' | 'deliver' | 'worktree' | 'limited'>;

/** A session's status as an agent's (as the daemon's AgentSummary works it out); undefined until it has run. */
export function sessionStatus(s: Pick<RoundUp, 'busy' | 'lastTurn' | 'limited'>, asking: boolean): AgentStatus | undefined {
  if (s.busy) return asking ? 'needs-approval' : 'working';
  if (s.limited) return 'paused';
  switch (s.lastTurn) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'stopped';
    default:
      return undefined;
  }
}

/**
 * The whole round-up's state, Kelpie (its orchestrator) and its sub-agents together: the most
 * urgent of their groups, as the Plan bar groups them. Something waiting on the person first, then
 * a failure nobody has acted on, anything working, branches waiting to be merged, anything stopped,
 * then done. Kelpie's own failure always counts; a sub-agent's only until Kelpie has had a turn
 * since. A round-up that has never run has no state yet. Pure.
 */
export function roundUpStatus(
  roundUp: StatusSession,
  sessions: Iterable<StatusSession>,
  approvals: readonly Pick<PendingApproval, 'roundUpId'>[],
): PlanGroup | undefined {
  if (approvals.some((a) => a.roundUpId === roundUp.id)) return 'needs-you';
  const groups: PlanGroup[] = [];
  const own = sessionStatus(roundUp, false);
  if (own) groups.push(planGroup({ ...roundUp, status: own }));
  for (const s of sessions) {
    if (s.parentId !== roundUp.id) continue;
    // One that has not run yet is `idle`, as its AgentSummary says.
    groups.push(planGroup({ ...s, status: sessionStatus(s, false) ?? 'idle' }, roundUp.updatedAt));
  }
  return mostUrgent(groups);
}
