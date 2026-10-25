import { describe, expect, it } from 'vitest';
import { relativeTime, shortPath, statusLine, type RoundUp } from '../src/lib/round-ups.js';
import { nextMode } from '../src/lib/modes.js';

const NOW = new Date('2026-10-23T12:00:00').getTime();
const MIN = 60_000;
const r = (over: Partial<RoundUp>): RoundUp => ({ id: 'x', title: '', cwd: '/r', createdAt: 0, updatedAt: NOW - 5 * MIN, busy: false, mode: 'auto', ...over });

describe('round-up rows', () => {
  it('says how long ago', () => {
    expect(relativeTime(NOW - 20_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 25 * MIN - 50_000, NOW)).toBe('25 minutes ago');
    expect(relativeTime(NOW - 3 * 60 * MIN, NOW)).toBe('3 hours ago');
  });

  it('shows working first, then how the last turn ended', () => {
    expect(statusLine(r({ busy: true, lastTurn: 'failed' }), NOW)).toEqual({ text: 'Working…', tone: 'busy' });
    expect(statusLine(r({ lastTurn: 'failed' }), NOW)).toEqual({ text: 'Failed · 5 minutes ago', tone: 'error' });
    expect(statusLine(r({ lastTurn: 'interrupted' }), NOW).text).toBe('Interrupted · 5 minutes ago');
    expect(statusLine(r({ lastTurn: 'completed' }), NOW).text).toBe('Idle · 5 minutes ago');
  });

  it('shortens home directories', () => {
    expect(shortPath('/Users/me/code/kelpie')).toBe('~/code/kelpie');
    expect(shortPath('/home/me')).toBe('~');
    expect(shortPath('/srv/app')).toBe('/srv/app');
  });
});


describe('modes', () => {
  it('cycles through the harness’s modes in order, wrapping round', () => {
    const modes = ['auto', 'acceptEdits', 'plan'] as const;
    expect(nextMode(modes, 'auto')).toBe('acceptEdits');
    expect(nextMode(modes, 'plan')).toBe('auto');
    expect(nextMode([], 'plan')).toBe('plan');
  });
});
