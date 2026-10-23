import { formatDistanceStrict } from 'date-fns';
import { generatePath } from 'react-router';

export const ROUND_UP_ROUTE = '/r/:roundUpId';
export const roundUpPath = (roundUpId: string) => generatePath(ROUND_UP_ROUTE, { roundUpId });

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
