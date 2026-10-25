import type { Mode } from '@kelpie/protocol';
import { formatDistanceStrict } from 'date-fns';
import { generatePath } from 'react-router';
import type { AgentStatus } from './agents.js';
import type { PendingApproval } from './approvals.js';

export const ROUND_UP_ROUTE = '/r/:roundUpId';
export const roundUpPath = (roundUpId: string) => generatePath(ROUND_UP_ROUTE, { roundUpId });

/** History state on a page opened from inside the app: the path it was opened from. */
export interface OpenedFrom {
  from: string;
}

/** A round-up as the daemon lists it (mirrors the daemon's `SessionInfo`). */
export interface RoundUp {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  busy: boolean;
  lastTurn?: 'completed' | 'failed' | 'interrupted';
  harnessSessionId?: string;
  /** Set on a sub-agent: the orchestrator round-up that spawned it. */
  parentId?: string;
  role?: 'orchestrator' | 'agent';
  /** The model asked for; absent for the harness's default. */
  model?: string;
  /** Ordinary work, or Muster (a sub-agent bringing other agents' branches together). */
  kind?: 'worker' | 'muster';
  /** The branch the round-up starts from (e.g. origin/main) and the commit it was pinned to, once chosen. */
  baseBranch?: string;
  baseCommit?: string;
  /** How freely its agents work; a sub-agent reports its round-up's. */
  mode: Mode;
}

export const NEW_TITLE = 'New round-up';

export const titleOf = (r: Pick<RoundUp, 'title'> | undefined) => r?.title || NEW_TITLE;

/** Home directories are noise in a path: `/Users/me/code/x` → `~/code/x`. */
export const shortPath = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');

/**
 * "3 minutes ago", "2 hours ago", "4 days ago"… Under a minute it is "just now": the
 * sidebar re-renders once a minute, so a seconds count would sit there going stale.
 */
export function relativeTime(ms: number, now: number): string {
  return now - ms < 60_000 ? 'just now' : formatDistanceStrict(ms, now, { addSuffix: true, roundingMethod: 'floor' });
}

export type StatusTone = 'busy' | 'error' | 'muted';

/** The second line of a round-up's row in the sidebar. */
export function statusLine(r: RoundUp, now: number): { text: string; tone: StatusTone } {
  if (r.busy) return { text: 'Working…', tone: 'busy' };
  const when = relativeTime(r.updatedAt, now);
  if (r.lastTurn === 'failed') return { text: `Failed · ${when}`, tone: 'error' };
  if (r.lastTurn === 'interrupted') return { text: `Interrupted · ${when}`, tone: 'muted' };
  return { text: `Idle · ${when}`, tone: 'muted' };
}

/** Most recently active first, as the daemon orders them. */
export const byRecent = (a: RoundUp, b: RoundUp) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;

/**
 * The line under a round-up's title: what its agents are up to ("2 working · 1 failed"),
 * or, with none moving, whether they are all done; a round-up without agents says its own state.
 */
export function roundUpSummary(r: RoundUp, agents: readonly { status: string }[], now: number): string {
  const when = relativeTime(r.updatedAt, now);
  if (!agents.length) return r.busy ? 'Working' : statusLine(r, now).text;
  const n = (status: string) => agents.filter((a) => a.status === status).length;
  const moving = [
    n('needs-approval') && `${n('needs-approval')} waiting on you`,
    n('working') && `${n('working')} working`,
    n('failed') && `${n('failed')} failed`,
  ].filter(Boolean);
  if (moving.length) return moving.join(' · ');
  return n('done') === agents.length ? `Done · ${when}` : `Idle · ${when}`;
}

/** A round-up's dot, from its orchestrator and every sub-agent: the same marks as an agent's. */
export type RoundUpStatus = Extract<AgentStatus, 'needs-approval' | 'failed' | 'working' | 'done'>;

export const ROUND_UP_STATUS_LABEL: Record<RoundUpStatus, string> = {
  'needs-approval': 'Needs your attention',
  failed: 'Failed',
  working: 'Working',
  done: 'Done',
};

type StatusSession = Pick<RoundUp, 'id' | 'busy' | 'lastTurn' | 'parentId'>;

/**
 * The whole round-up's state, Kelpie (its orchestrator) and its sub-agents together, most urgent
 * first: something waiting on the person (an approval, a plan to decide on), then a turn that
 * failed (a usage limit, say) and isn't being retried, then anything working, then done. A
 * round-up that has never finished a turn has no state yet. Pure.
 */
export function roundUpStatus(
  roundUp: StatusSession,
  sessions: Iterable<StatusSession>,
  approvals: readonly Pick<PendingApproval, 'roundUpId'>[],
): RoundUpStatus | undefined {
  if (approvals.some((a) => a.roundUpId === roundUp.id)) return 'needs-approval';
  const all = [roundUp];
  for (const s of sessions) if (s.parentId === roundUp.id) all.push(s);
  if (all.some((s) => !s.busy && s.lastTurn === 'failed')) return 'failed';
  if (all.some((s) => s.busy)) return 'working';
  return all.some((s) => s.lastTurn) ? 'done' : undefined;
}
