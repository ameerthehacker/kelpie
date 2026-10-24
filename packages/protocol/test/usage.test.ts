import { describe, expect, it } from 'vitest';
import { mergeUsage } from '../src/index.js';

const w = (utilization: number, resetsAt = '2026-01-01T00:00:00.000Z') => ({ utilization, resetsAt });

describe('mergeUsage', () => {
  it('keeps windows a report does not mention', () => {
    const prev = { status: 'allowed', windows: { five_hour: w(0.3), seven_day: w(0.6) } };
    expect(mergeUsage(prev, { status: 'allowed', windows: { five_hour: w(0.4) } }).windows).toEqual({ five_hour: w(0.4), seven_day: w(0.6) });
  });

  it('takes the status of a report without windows', () => {
    const prev = { status: 'allowed', windows: { five_hour: w(0.9) } };
    expect(mergeUsage(prev, { status: 'rejected', window: 'five_hour', resetsAt: '2026-01-01T05:00:00.000Z' })).toEqual({
      status: 'rejected',
      window: 'five_hour',
      resetsAt: '2026-01-01T05:00:00.000Z',
      windows: { five_hour: w(0.9) },
    });
    expect(mergeUsage(undefined, { status: 'allowed' })).toEqual({ status: 'allowed' });
  });
});
