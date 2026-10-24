import { describe, expect, it } from 'vitest';
import { limitHint, metersOf, resetText, type HarnessUsage } from '../src/lib/usage.js';

const NOW = new Date('2026-10-23T12:00:00').getTime();
const at = (iso: string) => new Date(iso).toISOString();
const report = (fiveHour: number, sevenDay: number, status = 'allowed'): HarnessUsage => ({
  harness: 'claude-code',
  updatedAt: NOW,
  usage: {
    status,
    windows: {
      five_hour: { utilization: fiveHour, resetsAt: at('2026-10-23T14:14:00') },
      seven_day: { utilization: sevenDay, resetsAt: at('2026-10-26T09:00:00') },
    },
  },
});

describe('usage meters', () => {
  it('shows both windows as the design does', () => {
    expect(metersOf(report(0.42, 0.61), NOW).map(({ label, pct, warn, reset }) => ({ label, pct, warn, reset }))).toEqual([
      { label: 'Usage limit', pct: 42, warn: false, reset: 'Resets in 2 hours 14 minutes' },
      { label: 'Weekly limit', pct: 61, warn: false, reset: 'Resets Mon 09:00' },
    ]);
  });

  it('turns amber at 80%, and drops a window that has already reset to 0%', () => {
    const [five, week] = metersOf(report(0.95, 0.86), new Date('2026-10-23T15:00:00').getTime());
    expect(five).toMatchObject({ pct: 0, warn: false, reset: 'Reset · updates on the next turn' });
    expect(week).toMatchObject({ pct: 86, warn: true });
  });

  it('says when a reset is under a minute away', () => {
    expect(resetText(new Date(NOW + 20_000), NOW)).toBe('Resets in under a minute');
  });

  it('counts elapsed time, so a DST change cannot turn 23.5 hours into 30 minutes', () => {
    expect(resetText(new Date(NOW + 23.5 * 3600_000), NOW)).toBe('Resets in 23 hours 30 minutes');
  });
});

describe('limit hint', () => {
  it('warns about the fullest window from 80%, and says when one is used up', () => {
    expect(limitHint(report(0.42, 0.61), NOW)).toBeUndefined();
    expect(limitHint(report(0.42, 0.86), NOW)).toBe('Claude Code is at 86% of its weekly limit. Long jobs may pause until Mon 09:00.');
    const rejected = { ...report(1, 0.5, 'rejected') };
    rejected.usage = { ...rejected.usage, window: 'five_hour', resetsAt: at('2026-10-23T14:14:00') };
    expect(limitHint(rejected, NOW)).toBe('Claude Code has hit its usage limit. It resets Fri 14:14.');
    // After that window resets, an old "rejected" no longer counts.
    expect(limitHint(rejected, new Date('2026-10-23T16:00:00').getTime())).toBeUndefined();
    expect(limitHint(undefined, NOW)).toBeUndefined();
  });
});
