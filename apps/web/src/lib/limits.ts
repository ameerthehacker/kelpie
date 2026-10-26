import { format, intervalToDuration, isSameDay } from 'date-fns';
import type { TurnLimit, UsageLimitPause } from '@kelpie/protocol';

export type { TurnLimit, UsageLimitPause };

/** When Kelpie resumes, in the person's own time: "6:00 PM" today, "Tue 6:00 PM" another day. */
export const clock = (ms: number, now: number): string => format(ms, isSameDay(ms, now) ? 'p' : 'EEE p');

/** How long until then, briefly: "2h 14m", "45m", "1d 3h", "under a minute". */
export function until(ms: number, now: number): string {
  if (ms - now < 60_000) return 'under a minute';
  const d = intervalToDuration({ start: now, end: ms });
  const parts = [d.days && `${d.days}d`, d.hours && `${d.hours}h`, !d.days && d.minutes && `${d.minutes}m`].filter(Boolean);
  return parts.join(' ') || 'under a minute';
}

/** "Resumes 6:00 PM", or "Won't auto-resume": the short line on an agent's row. */
export function pausedShort(p: UsageLimitPause, now: number): string {
  return p.retryAt ? `Resumes ${clock(p.retryAt, now)}` : p.gaveUp ? 'Auto-resume gave up' : 'Won’t auto-resume';
}

/** "Paused · resumes 6:00 PM": a round-up's status line, and its row in the sidebar. */
export function pausedStatus(p: UsageLimitPause, now: number): string {
  return p.retryAt ? `Paused · resumes ${clock(p.retryAt, now)}` : p.gaveUp ? 'Paused · auto-resume gave up' : 'Paused · won’t auto-resume';
}

/** "Paused for usage limit · resumes at 6:00 PM (in 2h 14m)", or that Kelpie won't on its own. */
export function pausedLabel(p: UsageLimitPause, now: number): string {
  if (p.retryAt) return `Paused for usage limit · resumes at ${clock(p.retryAt, now)}${p.retryAt > now ? ` (in ${until(p.retryAt, now)})` : ''}`;
  if (p.gaveUp) return `Paused for usage limit · Kelpie stopped trying after ${p.attempts} tries`;
  return `Paused for usage limit · won’t resume on its own${p.resetsAt && p.resetsAt > now ? ` (resets ${clock(p.resetsAt, now)})` : ''}`;
}

/**
 * The chat's line for a turn that stopped at the limit, as it was when it stopped: "Hit the usage
 * limit. Kelpie will resume at 6:00 PM (in 2h 14m)." A try that found the limit still there says so.
 */
export function limitLine(limit: TurnLimit, now: number): string {
  const lead = limit.attempts ? 'Still at the usage limit.' : 'Hit the usage limit.';
  if (!limit.retryAt) {
    const reset = limit.resetsAt && Date.parse(limit.resetsAt);
    return `${lead} Kelpie won’t resume this on its own${reset && reset > now ? `; the limit resets at ${clock(reset, now)}` : ''}.`;
  }
  const at = Date.parse(limit.retryAt);
  const verb = limit.attempts ? 'try again' : 'resume';
  return at > now ? `${lead} Kelpie will ${verb} at ${clock(at, now)} (in ${until(at, now)}).` : `${lead} Kelpie was to ${verb} at ${clock(at, now)}.`;
}

export const RESUMED_LINE = 'Resumed after usage limit';

/** The soonest of some pauses' resume times, if any will resume on its own. */
export function soonest(pauses: Iterable<UsageLimitPause | undefined>): number | undefined {
  let at: number | undefined;
  for (const p of pauses) if (p?.retryAt && (at === undefined || p.retryAt < at)) at = p.retryAt;
  return at;
}
