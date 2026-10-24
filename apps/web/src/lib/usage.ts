import { format, formatDuration } from 'date-fns';
import type { HarnessUsage } from '@kelpie/protocol';

export type { HarnessUsage };

export const HARNESSES: Record<string, { name: string; mark: string }> = {
  'claude-code': { name: 'Claude Code', mark: 'CC' },
  codex: { name: 'Codex', mark: 'CX' },
};

/** The windows the design shows, in its order and words. */
const WINDOWS = [
  { key: 'five_hour', label: 'Usage limit', noun: 'usage limit' },
  { key: 'seven_day', label: 'Weekly limit', noun: 'weekly limit' },
];

/** At or above this a meter turns amber and the composer warns. */
export const WARN_AT = 80;

export interface Meter {
  label: string;
  noun: string;
  pct: number;
  warn: boolean;
  resetsAt: Date;
  /** "Resets in 2 hours 14 minutes", "Resets Mon 09:00", or that it has reset. */
  reset: string;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** When a window resets, said the way the design says it. */
export function resetText(resetsAt: Date, now: number): string {
  const left = resetsAt.getTime() - now;
  if (left <= 0) return 'Reset · updates on the next turn';
  if (left >= DAY) return `Resets ${format(resetsAt, 'EEE HH:mm')}`;
  // Elapsed time, not calendar time: across a DST change a calendar interval can gain a "day".
  const minutes = Math.floor(left / MINUTE);
  const duration = formatDuration({ hours: Math.floor(minutes / 60), minutes: minutes % 60 }, { format: ['hours', 'minutes'] });
  return duration ? `Resets in ${duration}` : 'Resets in under a minute';
}

/**
 * A harness's meters. A window whose reset time has passed shows 0%: the harness
 * only reports during a turn, so the old figure no longer holds.
 */
export function metersOf(u: HarnessUsage, now: number): Meter[] {
  return WINDOWS.flatMap(({ key, label, noun }) => {
    const w = u.usage.windows?.[key];
    if (!w) return [];
    const resetsAt = new Date(w.resetsAt);
    const pct = resetsAt.getTime() <= now ? 0 : Math.round(w.utilization * 100);
    return [{ label, noun, pct, warn: pct >= WARN_AT, resetsAt, reset: resetText(resetsAt, now) }];
  });
}

/**
 * The composer's warning for a harness close to (or at) a limit, if any. A report only
 * counts until the window it is about resets: usage is reported during turns, so after a
 * reset nothing newer may have come in.
 */
export function limitHint(u: HarnessUsage | undefined, now: number): string | undefined {
  if (!u) return undefined;
  const name = HARNESSES[u.harness]?.name ?? u.harness;
  const { status, window, resetsAt } = u.usage;
  if (status === 'rejected' && resetsAt && new Date(resetsAt).getTime() > now) {
    const noun = WINDOWS.find((w) => w.key === window)?.noun ?? 'usage limit';
    return `${name} has hit its ${noun}. It resets ${format(new Date(resetsAt), 'EEE HH:mm')}.`;
  }
  const fullest = metersOf(u, now).sort((a, b) => b.pct - a.pct)[0];
  if (!fullest?.warn) return undefined;
  const until = format(fullest.resetsAt, 'EEE HH:mm');
  if (fullest.pct >= 100) return `${name} has hit its ${fullest.noun}. It resets ${until}.`;
  return `${name} is at ${fullest.pct}% of its ${fullest.noun}. Long jobs may pause until ${until}.`;
}
