import { tz, TZDate } from '@date-fns/tz';
import { addDays, addYears, isValid, parse } from 'date-fns';

/** A turn the harness ended because the person's usage limit was hit: not a failure of the work. */
export interface UsageLimitStop {
  /** When the limit resets, if the harness said so (structured, or in its message). */
  resetsAt?: Date;
  /** The harness's own words, e.g. "You've hit your session limit · resets 6pm (Asia/Calcutta)". */
  message: string;
}

const HOUR = 60 * 60_000;

/** How the CLI writes a reset time: `6pm`, `10:30pm`, `Oct 27, 9am`, `Oct 27, 2027, 9:15am`. Time-only ones are within a day. */
const FORMATS: { format: string; dated: boolean; year: boolean }[] = [
  { format: 'h:mma', dated: false, year: false },
  { format: 'ha', dated: false, year: false },
  { format: 'MMM d, yyyy, h:mma', dated: true, year: true },
  { format: 'MMM d, yyyy, ha', dated: true, year: true },
  { format: 'MMM d, h:mma', dated: true, year: false },
  { format: 'MMM d, ha', dated: true, year: false },
  { format: 'MMM d, yyyy', dated: true, year: true },
  { format: 'MMM d', dated: true, year: false },
];

/** An IANA zone the runtime knows (`Asia/Calcutta`), or undefined. */
function knownZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/**
 * The reset time in a limit message, as an instant: "resets 6pm (Asia/Calcutta)", "resets 10:30pm
 * (America/New_York)", "resets Oct 27, 9am (Europe/London)", or "resets in 2h 14m". The wall time
 * is read in the zone the message names (the machine's own without one). A time without a date is
 * the next one to come (a time well past means tomorrow), and a date without a year the next such
 * date, both counted in that zone's calendar so midnight and DST changes fall where they should.
 * Undefined when there is no reset time it can read.
 */
export function resetFromText(text: string, now: Date = new Date()): Date | undefined {
  const rel = /\bresets in\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i.exec(text);
  if (rel && (rel[1] || rel[2])) return new Date(now.getTime() + (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000);
  const m = /\bresets\s+(?:at\s+)?([A-Za-z]{3} \d{1,2}(?:, \d{4})?(?:, \d{1,2}(?::\d{2})?\s?[ap]m)?|\d{1,2}(?::\d{2})?\s?[ap]m)(?:\s*\(([^)]+)\))?/i.exec(text);
  if (!m) return undefined;
  const zone = knownZone(m[2]?.trim());
  // Named but unknown: the wall time can't be placed, so it is no better than none.
  if (m[2] && !zone) return undefined;
  const value = m[1]!.replace(/\s?([ap]m)$/i, (_, ap: string) => ap.toLowerCase());
  const opts = zone ? { in: tz(zone) } : {};
  const ref = zone ? new TZDate(now, zone) : now;
  for (const f of FORMATS) {
    const d = parse(value, f.format, ref, opts);
    if (!isValid(d)) continue;
    // Within the hour just gone: the reset has only now come (clocks differ a little); otherwise it is the next one.
    if (!f.dated && d.getTime() < now.getTime() - HOUR) return new Date(addDays(d, 1, opts).getTime());
    if (f.dated && !f.year && d.getTime() < now.getTime() - 24 * HOUR) return new Date(addYears(d, 1, opts).getTime());
    return new Date(d.getTime());
  }
  return undefined;
}
