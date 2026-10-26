import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import { openStore, type Store } from '@kelpie/store';
import { backoff, MAX_TRIES, PROBE_MS, RECENT_RETRY_MS, RESET_BUFFER_MS, STAGGER_MS, UsageLimits, type LimitTarget } from '../src/usage-limits.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-26T08:43:20Z');
const RESET = Date.parse('2026-10-26T12:30:00Z');
const MESSAGE = "You've hit your session limit · resets 6pm (Asia/Calcutta)";

const event = (kind: string, data: unknown): KelpieEvent => ({ id: 'x', runId: 'r', seq: 0, ts: '', harness: 'claude-code', kind, data }) as KelpieEvent;
const through = event('turn.ended', { status: 'completed' });
const limitedAgain = event('turn.ended', { status: 'failed', error: MESSAGE, limit: {} });

interface Fake extends LimitTarget {
  working: boolean;
}

function setup(store: Store = openStore(':memory:'), opts: { enabled?: () => boolean; resume?: (id: string) => Promise<void> } = {}) {
  const targets = new Map<string, Fake>();
  const resumed: string[] = [];
  const changed: string[] = [];
  let looks = 0;
  const limits = new UsageLimits({
    store,
    get: (id) => (looks++, targets.get(id)),
    resume:
      opts.resume ??
      (async (id) => {
        resumed.push(id);
      }),
    enabled: opts.enabled ?? (() => true),
    changed: (id) => changed.push(id),
  });
  const add = (id: string, role: 'orchestrator' | 'agent' = 'agent', harness = 'claude-code') => {
    store.createSession({ id, cwd: '/r', role, harness }, targets.size);
    const t: Fake = { id, harness, role, working: false, createdAt: targets.size };
    targets.set(id, t);
    return t;
  };
  /** How often the scheduler has looked a session up: a measure of how busy its timer is. */
  const looked = () => looks;
  return { limits, store, targets, resumed, changed, add, looked };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('UsageLimits', () => {
  it('pauses a session until the reset, plus a buffer, and says so', () => {
    const { limits, add, resumed } = setup();
    const a = add('a');
    const turn = limits.hit(a, { message: MESSAGE, resetsAt: new Date(RESET) }, { window: 'five_hour' });
    expect(turn).toEqual({ window: 'five_hour', resetsAt: '2026-10-26T12:30:00.000Z', retryAt: new Date(RESET + RESET_BUFFER_MS).toISOString(), attempts: 0 });
    expect(limits.pause('a')).toEqual({ since: T0, resetsAt: RESET, retryAt: RESET + RESET_BUFFER_MS, attempts: 0, message: MESSAGE });
    limits.start();
    vi.advanceTimersByTime(RESET + RESET_BUFFER_MS - T0 - 1);
    expect(resumed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(resumed).toEqual(['a']);
  });

  it('resumes one first as a probe, then the rest a few seconds apart, agents before their orchestrator', () => {
    const { limits, add, resumed, targets } = setup();
    const orch = add('orch', 'orchestrator');
    for (const t of [orch, add('a'), add('b'), add('c')]) limits.hit(t, { message: MESSAGE, resetsAt: new Date(RESET) });
    limits.start();
    vi.advanceTimersByTime(RESET + RESET_BUFFER_MS - Date.now());
    expect(resumed).toEqual(['a']);
    // The others wait while the probe is out.
    vi.advanceTimersByTime(PROBE_MS - 1);
    expect(resumed).toEqual(['a']);
    // It got through: the limit is over, so the rest go, staggered.
    targets.get('a')!.working = true;
    limits.observe(targets.get('a')!, event('rate_limit', { status: 'allowed' }));
    expect(limits.pause('a')).toBeUndefined();
    vi.advanceTimersByTime(0);
    expect(resumed).toEqual(['a', 'b']);
    vi.advanceTimersByTime(STAGGER_MS);
    expect(resumed).toEqual(['a', 'b', 'c']);
    vi.advanceTimersByTime(STAGGER_MS);
    expect(resumed).toEqual(['a', 'b', 'c', 'orch']);
    vi.advanceTimersByTime(60 * MIN);
    expect(resumed).toHaveLength(4);
  });

  it('reschedules everyone when the probe hits the limit again, instead of trying each', () => {
    const { limits, add, resumed, targets } = setup();
    for (const id of ['a', 'b', 'c']) limits.hit(add(id), { message: MESSAGE, resetsAt: new Date(RESET) });
    limits.start();
    vi.advanceTimersByTime(RESET + RESET_BUFFER_MS - Date.now());
    expect(resumed).toEqual(['a']);
    // Still limited: the weekly limit now, until Oct 30.
    const later = Date.parse('2026-10-30T08:45:00Z');
    const turn = limits.hit(targets.get('a')!, { message: "You've hit your weekly limit · resets Oct 30, 2:15pm (Asia/Calcutta)", resetsAt: new Date(later) });
    expect(turn).toMatchObject({ attempts: 1, retryAt: new Date(later + RESET_BUFFER_MS).toISOString() });
    for (const id of ['b', 'c']) expect(limits.pause(id)).toMatchObject({ retryAt: later + RESET_BUFFER_MS, attempts: 0 });
    vi.advanceTimersByTime(PROBE_MS * 3);
    expect(resumed).toEqual(['a']);
    vi.advanceTimersByTime(later + RESET_BUFFER_MS - Date.now());
    expect(resumed).toEqual(['a', 'a']);
  });

  it('backs off without a reset time (15m, 30m, then hourly) and gives up after a while', () => {
    const { limits, add, resumed } = setup();
    const a = add('a');
    expect([0, 1, 2, 5].map(backoff)).toEqual([15 * MIN, 30 * MIN, 60 * MIN, 60 * MIN]);
    limits.hit(a, { message: "You've hit your session limit" });
    limits.start();
    let waited = 0;
    for (let tries = 0; tries < MAX_TRIES; tries++) {
      expect(limits.pause('a')).toMatchObject({ attempts: tries, retryAt: Date.now() + backoff(tries) });
      vi.advanceTimersByTime(backoff(tries));
      waited += backoff(tries);
      expect(resumed).toHaveLength(tries + 1);
      limits.hit(a, { message: "You've hit your session limit" });
    }
    // Twelve tries over most of a day: it stays paused, for the person to resume.
    expect(waited).toBe((15 + 30 + 10 * 60) * MIN);
    expect(limits.pause('a')).toMatchObject({ attempts: MAX_TRIES });
    expect(limits.pause('a')!.retryAt).toBeUndefined();
    vi.advanceTimersByTime(24 * 60 * MIN);
    expect(resumed).toHaveLength(MAX_TRIES);
  });

  it('tries again soon when refused just after its reset, and backs off when the reset is long gone or past belief', () => {
    const { limits, add } = setup();
    // The clocks are a little apart: in 5 minutes, not a half-hour backoff.
    expect(limits.hit(add('a'), { message: MESSAGE, resetsAt: new Date(T0 - 10 * MIN) })).toMatchObject({ retryAt: new Date(T0 + RECENT_RETRY_MS).toISOString() });
    expect(limits.hit(add('b'), { message: MESSAGE, resetsAt: new Date(T0 - 3 * 60 * MIN) })).toMatchObject({ retryAt: new Date(T0 + 15 * MIN).toISOString() });
    // A reset weeks away is no plan's: treated as unknown.
    const far = limits.hit(add('c'), { message: MESSAGE, resetsAt: new Date(T0 + 30 * 24 * 60 * MIN) });
    expect(far).toMatchObject({ retryAt: new Date(T0 + 15 * MIN).toISOString() });
    expect(far.resetsAt).toBeUndefined();
    expect(limits.pause('c')!.resetsAt).toBeUndefined();
  });

  it("doesn't spin its timer while a probe is out, or while a due session is working", () => {
    const { limits, add, resumed, targets, looked } = setup();
    for (const id of ['a', 'b', 'c']) limits.hit(add(id), { message: MESSAGE, resetsAt: new Date(RESET) });
    limits.start();
    vi.advanceTimersByTime(RESET + RESET_BUFFER_MS - Date.now());
    expect(resumed).toEqual(['a']);
    // B and C are due, but wait on the probe: the timer must not fire again and again meanwhile.
    let before = looked();
    vi.advanceTimersByTime(PROBE_MS - 1);
    expect(looked() - before).toBeLessThan(5);
    expect(resumed).toEqual(['a']);
    // A due session the person is working with is looked at every so often, not in a loop.
    limits.observe(targets.get('a')!, through);
    targets.get('b')!.working = true;
    targets.get('c')!.working = true;
    vi.advanceTimersByTime(STAGGER_MS * 3);
    before = looked();
    vi.advanceTimersByTime(60_000);
    expect(looked() - before).toBeLessThan(20);
  });

  it('fans out only to sessions at the same limit, or already due: a weekly limit waits for its own reset', () => {
    const { limits, add, resumed, targets } = setup();
    const WEEKLY = Date.parse('2026-10-30T08:45:00Z');
    limits.hit(add('a'), { message: MESSAGE, resetsAt: new Date(RESET) });
    limits.hit(add('b'), { message: MESSAGE, resetsAt: new Date(RESET) });
    limits.hit(add('weekly'), { message: "You've hit your weekly limit · resets Oct 30, 2:15pm (Asia/Calcutta)", resetsAt: new Date(WEEKLY) });
    limits.start();
    vi.advanceTimersByTime(RESET + RESET_BUFFER_MS - Date.now());
    expect(resumed).toEqual(['a']);
    limits.observe(targets.get('a')!, through);
    vi.advanceTimersByTime(STAGGER_MS * 5);
    expect(resumed).toEqual(['a', 'b']);
    expect(limits.pause('weekly')).toMatchObject({ retryAt: WEEKLY + RESET_BUFFER_MS });
    vi.advanceTimersByTime(WEEKLY + RESET_BUFFER_MS - Date.now());
    expect(resumed).toEqual(['a', 'b', 'weekly']);
  });

  it('gives up after its tries when the harness keeps exiting without an answer', () => {
    const { limits, add, resumed, targets } = setup();
    const a = add('a');
    limits.hit(a, { message: MESSAGE, resetsAt: new Date(RESET) });
    limits.start();
    vi.advanceTimersByTime(RESET + RESET_BUFFER_MS - Date.now());
    for (let tries = 1; tries <= MAX_TRIES; tries++) {
      expect(resumed).toHaveLength(tries);
      limits.observe(targets.get('a')!, event('process.exited', { code: 1, signal: null, stderrTail: 'claude: not found' }));
      vi.advanceTimersByTime(backoff(tries));
    }
    expect(limits.pause('a')).toMatchObject({ attempts: MAX_TRIES, gaveUp: true });
    expect(limits.pause('a')!.retryAt).toBeUndefined();
    vi.advanceTimersByTime(24 * 60 * MIN);
    expect(resumed).toHaveLength(MAX_TRIES);
  });

  it('gives up after its tries when resuming keeps failing', async () => {
    let calls = 0;
    const { limits, add } = setup(openStore(':memory:'), {
      resume: async () => {
        calls++;
        throw new Error('worktree is gone');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    limits.hit(add('a'), { message: MESSAGE, resetsAt: new Date(RESET) });
    limits.start();
    await vi.advanceTimersByTimeAsync(RESET + RESET_BUFFER_MS - Date.now());
    for (let tries = 1; tries < MAX_TRIES; tries++) await vi.advanceTimersByTimeAsync(backoff(tries));
    expect(calls).toBe(MAX_TRIES);
    expect(limits.pause('a')).toMatchObject({ attempts: MAX_TRIES, gaveUp: true });
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN);
    expect(calls).toBe(MAX_TRIES);
  });

  it('drops a staggered resume when the person picked the session up, or turned auto-resume off, meanwhile', () => {
    let on = true;
    const { limits, add, resumed, targets } = setup(openStore(':memory:'), { enabled: () => on });
    for (const id of ['a', 'b', 'c', 'd']) limits.hit(add(id), { message: MESSAGE, resetsAt: new Date(RESET) });
    limits.start();
    vi.advanceTimersByTime(RESET + RESET_BUFFER_MS - Date.now());
    limits.observe(targets.get('a')!, through);
    vi.advanceTimersByTime(0);
    expect(resumed).toEqual(['a', 'b']);
    // The person sends C something before its turn comes.
    targets.get('c')!.working = true;
    vi.advanceTimersByTime(STAGGER_MS);
    expect(resumed).toEqual(['a', 'b']);
    // And turns auto-resume off before D's.
    on = false;
    vi.advanceTimersByTime(STAGGER_MS);
    expect(resumed).toEqual(['a', 'b']);
  });

  it("stops on the person's say-so, and resumes now when asked", () => {
    const { limits, add, resumed, store } = setup();
    limits.hit(add('a'), { message: MESSAGE, resetsAt: new Date(RESET) });
    limits.start();
    expect(limits.cancel('a')).toBe(true);
    expect(limits.pause('a')!.retryAt).toBeUndefined();
    expect(store.limitOf('a')).toMatchObject({ auto: false });
    vi.advanceTimersByTime(RESET + RESET_BUFFER_MS - Date.now() + 10 * MIN);
    expect(resumed).toEqual([]);
    expect(limits.resumeNow('a')).toBe(true);
    expect(resumed).toEqual(['a']);
    expect(limits.cancel('nobody')).toBe(false);
    expect(limits.resumeNow('nobody')).toBe(false);
  });

  it('resumes everything paused once a session the person picked up gets through', () => {
    const { limits, add, resumed, targets } = setup();
    for (const id of ['a', 'b']) limits.hit(add(id), { message: MESSAGE, resetsAt: new Date(RESET) });
    limits.start();
    // The limit lifted early (the person bought more usage) and they messaged A.
    limits.observe(targets.get('a')!, through);
    vi.advanceTimersByTime(0);
    expect(resumed).toEqual(['b']);
  });

  it('holds off while the setting is off, and goes once it is on again', () => {
    let on = false;
    const { limits, add, resumed, changed } = setup(openStore(':memory:'), { enabled: () => on });
    limits.hit(add('a'), { message: MESSAGE, resetsAt: new Date(RESET) });
    limits.start();
    expect(limits.pause('a')!.retryAt).toBeUndefined();
    vi.setSystemTime(RESET + 2 * RESET_BUFFER_MS);
    vi.advanceTimersByTime(10 * MIN);
    expect(resumed).toEqual([]);
    on = true;
    changed.length = 0;
    limits.settingChanged();
    expect(changed).toEqual(['a']);
    vi.advanceTimersByTime(0);
    expect(resumed).toEqual(['a']);
  });

  it('tries again later when a resumed harness exits without an answer', () => {
    const { limits, add, resumed, targets } = setup();
    limits.hit(add('a'), { message: MESSAGE, resetsAt: new Date(RESET) });
    limits.start();
    vi.advanceTimersByTime(RESET + RESET_BUFFER_MS - Date.now());
    expect(resumed).toEqual(['a']);
    limits.observe(targets.get('a')!, event('process.exited', { code: 1, signal: null, stderrTail: 'claude: not found' }));
    expect(limits.pause('a')).toMatchObject({ attempts: 1, retryAt: Date.now() + backoff(1) });
    expect(limitedAgain.kind).toBe('turn.ended');
  });

  it('keeps pauses across a restart: what is due resumes at once, the rest at its time', () => {
    vi.useRealTimers();
    const db = join(mkdtempSync(join(tmpdir(), 'kelpie-home-')), 'kelpie.db');
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const first = setup(openStore(db));
    first.limits.hit(first.add('soon'), { message: MESSAGE, resetsAt: new Date(T0 + 10 * MIN) });
    first.limits.hit(first.add('same'), { message: MESSAGE, resetsAt: new Date(T0 + 10 * MIN) });
    first.limits.hit(first.add('later'), { message: MESSAGE, resetsAt: new Date(T0 + 60 * MIN) }, undefined);
    first.limits.start();
    first.limits.stop();
    first.store.close();

    // Kelpie was off past the first reset.
    vi.setSystemTime(T0 + 30 * MIN);
    const second = setup(openStore(db));
    second.targets.set('soon', { id: 'soon', harness: 'claude-code', role: 'agent', working: false, createdAt: 0 });
    second.targets.set('same', { id: 'same', harness: 'claude-code', role: 'agent', working: false, createdAt: 1 });
    second.targets.set('later', { id: 'later', harness: 'claude-code', role: 'agent', working: false, createdAt: 2 });
    expect(second.limits.pause('soon')).toMatchObject({ resetsAt: T0 + 10 * MIN, retryAt: T0 + 10 * MIN + RESET_BUFFER_MS });
    // Nothing goes before it is started (Kelpie checks the harness can start first).
    vi.advanceTimersByTime(0);
    expect(second.resumed).toEqual([]);
    second.limits.start();
    vi.advanceTimersByTime(0);
    expect(second.resumed).toEqual(['soon']);
    second.limits.observe(second.targets.get('soon')!, through);
    vi.advanceTimersByTime(STAGGER_MS);
    // That limit is over: the other session at it follows (it was due too); the one at a later reset waits for it.
    expect(second.resumed).toEqual(['soon', 'same']);
    vi.advanceTimersByTime(T0 + 60 * MIN + RESET_BUFFER_MS - Date.now());
    expect(second.resumed).toEqual(['soon', 'same', 'later']);
    second.store.close();
  });
});
