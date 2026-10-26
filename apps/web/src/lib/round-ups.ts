import type { LinkedTicket, Mode } from '@kelpie/protocol';
import { formatDistanceStrict } from 'date-fns';
import { generatePath } from 'react-router';
import type { AgentSummary } from './agents.js';
import { groupCounts, planGroup, type Placed } from './status.js';

export const ROUND_UP_ROUTE = '/r/:roundUpId';
export const roundUpPath = (roundUpId: string) => generatePath(ROUND_UP_ROUTE, { roundUpId });

/** History state on a page opened from inside the app: the path it was opened from. */
export interface OpenedFrom {
  from: string;
}

/**
 * How to go back up to `to` (a sub-agent's round-up) from the page at `location`. Opened from
 * there: step back through history. Reached some other way inside the app (the approvals page,
 * search): go there in place of this entry, so the browser's back still returns to where the
 * person was. Landed on directly (a link, a new tab): go there as a new entry, keeping this one.
 * `key` is React Router's, `'default'` for the entry the app was loaded on.
 */
export function wayBack(to: string, location: { state: unknown; key: string }): 'back' | 'replace' | 'push' {
  if ((location.state as Partial<OpenedFrom> | null)?.from === to) return 'back';
  return location.key === 'default' ? 'push' : 'replace';
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
  /** Jira and Asana tickets linked to a top-level round-up, in the order they were linked. */
  tickets?: LinkedTicket[];
  /** A sub-agent's own branch and its worktree's state: whether its work still waits to be mustered. */
  branch?: AgentSummary['branch'];
  deliver?: AgentSummary['deliver'];
  worktree?: AgentSummary['worktree'];
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

/** A round-up's own state, in words: what its row says when there is no dot (see `roundUpStatus`), and the line under its title without agents. */
export function statusLine(r: RoundUp, now: number): { text: string; tone: StatusTone } {
  if (r.busy) return { text: 'Working…', tone: 'busy' };
  const when = relativeTime(r.updatedAt, now);
  if (r.lastTurn === 'failed') return { text: `Failed · ${when}`, tone: 'error' };
  if (r.lastTurn === 'interrupted') return { text: `Stopped · ${when}`, tone: 'muted' };
  if (r.lastTurn === 'completed') return { text: `Done · ${when}`, tone: 'muted' };
  return { text: `Idle · ${when}`, tone: 'muted' };
}

/** Most recently active first, as the daemon orders them. */
export const byRecent = (a: RoundUp, b: RoundUp) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;

/**
 * The line under a round-up's title: what its agents are up to ("1 needs you · 2 working"), or,
 * with none moving, where they stand ("2 ready to merge · 3 done", "Done"), grouped as the Plan bar
 * groups them; a round-up without agents says its own state.
 */
export function roundUpSummary(r: RoundUp, agents: readonly Placed[], now: number): string {
  if (!agents.length) return r.busy ? 'Working' : statusLine(r, now).text;
  const groups = agents.map((a) => planGroup(a, r.updatedAt));
  const moving = groupCounts(groups, ['needs-you', 'failed', 'working']);
  if (moving.length) return moving.join(' · ');
  if (groups.every((g) => g === 'done')) return `Done · ${relativeTime(r.updatedAt, now)}`;
  return groupCounts(groups).join(' · ');
}
