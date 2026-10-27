import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KelpieEvent, UsageLimitPause } from '@kelpie/protocol';
import type { AgentSummary } from '../src/lib/agents.js';
import { BUNDLE_MS, classifySession, createAttention, loudness, summarize, type AttentionSettings, type Delivery } from '../src/lib/attention.js';
import { buildChat, type AssistantPart } from '../src/lib/chat.js';
import { clock, limitLine, pausedLabel, pausedShort, soonest, until } from '../src/lib/limits.js';
import { planBar, planLabel } from '../src/lib/plan.js';
import { roundUpSummary, statusLine, type RoundUp } from '../src/lib/round-ups.js';
import { planGroup, roundUpStatus, sessionStatus } from '../src/lib/status.js';

// Local times, so the expectations hold in any time zone: the person sees their own. Mon 26 Oct 2026;
// what reads the clock itself (a notification's time) runs with the clock pinned here.
const NOW = new Date(2026, 9, 26, 15, 46).getTime();
const SIX_PM = new Date(2026, 9, 26, 18, 0).getTime();
const TOMORROW_9AM = new Date(2026, 9, 27, 9, 0).getTime();
const MESSAGE = "You've hit your session limit · resets 6pm (Asia/Calcutta)";
const pause = (over: Partial<UsageLimitPause> = {}): UsageLimitPause => ({ since: NOW - 60_000, resetsAt: SIX_PM - 90_000, retryAt: SIX_PM, attempts: 0, message: MESSAGE, ...over });

describe('limit times', () => {
  it("says when, in the person's time, and how long until then", () => {
    expect(clock(SIX_PM, NOW)).toBe('6:00 PM');
    expect(clock(TOMORROW_9AM, NOW)).toBe('Tue 9:00 AM');
    expect(until(SIX_PM, NOW)).toBe('2h 14m');
    expect(until(NOW + 45 * 60_000, NOW)).toBe('45m');
    expect(until(NOW + 20_000, NOW)).toBe('under a minute');
    expect(until(NOW + (26 * 60 + 5) * 60_000, NOW)).toBe('1d 2h');
  });

  it('names the day only when the reset is on another day, across midnight and DST changes', () => {
    const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
    // Later today: the time alone, up to the last minute of the day.
    expect(clock(local(26, 23, 59), NOW)).toBe('11:59 PM');
    // Tomorrow, or later in the week: the day too.
    expect(clock(local(27, 0, 0), NOW)).toBe('Tue 12:00 AM');
    expect(clock(local(29, 9, 0), NOW)).toBe('Thu 9:00 AM');
    // Across midnight: ten to twelve, and a reset half an hour later is tomorrow's...
    expect(clock(local(27, 0, 20), local(26, 23, 50))).toBe('Tue 12:20 AM');
    expect(until(local(27, 0, 20), local(26, 23, 50))).toBe('30m');
    // ...but once past midnight, that same day's reset is today's again, and yesterday's names its day.
    expect(clock(local(27, 18, 0), local(27, 0, 10))).toBe('6:00 PM');
    expect(clock(local(26, 18, 0), local(27, 0, 10))).toBe('Mon 6:00 PM');
    // The day the clocks change (Europe on Oct 25, the US on Nov 1): still the same day, or not, by the calendar.
    expect(clock(new Date(2026, 10, 1, 23, 0).getTime(), new Date(2026, 10, 1, 0, 30).getTime())).toBe('11:00 PM');
    expect(clock(new Date(2026, 10, 1, 3, 0).getTime(), new Date(2026, 9, 31, 23, 30).getTime())).toBe('Sun 3:00 AM');
    expect(clock(local(25, 22, 0), local(25, 0, 30))).toBe('10:00 PM');
  });

  it('describes a pause, and one Kelpie will not resume on its own', () => {
    expect(pausedLabel(pause(), NOW)).toBe('Paused for usage limit · resumes at 6:00 PM (in 2h 14m)');
    expect(pausedShort(pause(), NOW)).toBe('Resumes 6:00 PM');
    expect(pausedLabel(pause({ retryAt: undefined, resetsAt: SIX_PM }), NOW)).toBe('Paused for usage limit · won’t resume on its own (resets 6:00 PM)');
    expect(pausedShort(pause({ retryAt: undefined }), NOW)).toBe('Won’t auto-resume');
    expect(pausedShort(pause({ retryAt: undefined, gaveUp: true }), NOW)).toBe('Auto-resume gave up');
    expect(pausedLabel(pause({ retryAt: undefined, attempts: 12, gaveUp: true }), NOW)).toBe('Paused for usage limit · Kelpie stopped trying after 12 tries');
    expect(soonest([pause(), undefined, pause({ retryAt: SIX_PM - 1000 }), pause({ retryAt: undefined })])).toBe(SIX_PM - 1000);
  });

  it("words the chat's line as it was when the turn stopped", () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(limitLine({ retryAt: iso(SIX_PM), attempts: 0 }, NOW)).toBe('Hit the usage limit. Kelpie will resume at 6:00 PM (in 2h 14m).');
    expect(limitLine({ retryAt: iso(SIX_PM), attempts: 1 }, NOW)).toBe('Still at the usage limit. Kelpie will try again at 6:00 PM (in 2h 14m).');
    expect(limitLine({ retryAt: iso(SIX_PM), attempts: 0 }, SIX_PM + 60_000)).toBe('Hit the usage limit. Kelpie was to resume at 6:00 PM.');
    expect(limitLine({ resetsAt: iso(SIX_PM), attempts: 0 }, NOW)).toBe('Hit the usage limit. Kelpie won’t resume this on its own; the limit resets at 6:00 PM.');
  });
});

describe('the paused state', () => {
  const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
    id: 'a1',
    parentId: 'r1',
    title: 'Checkout API',
    harness: 'claude-code',
    writes: true,
    browser: false,
    status: 'paused',
    now: MESSAGE,
    todos: [],
    limited: pause(),
    createdAt: 1,
    updatedAt: NOW,
    ...over,
  });
  const roundUp = (over: Partial<RoundUp> = {}): RoundUp => ({ id: 'r1', title: 'Checkout', cwd: '/r', createdAt: 1, updatedAt: NOW, busy: false, mode: 'auto', ...over });

  it('is its own group: not failed, and calmer than working', () => {
    expect(sessionStatus({ busy: false, lastTurn: 'failed', limited: pause() }, false)).toBe('paused');
    expect(sessionStatus({ busy: true, lastTurn: 'failed', limited: pause() }, false)).toBe('working');
    expect(sessionStatus({ busy: false, lastTurn: 'failed' }, false)).toBe('failed');
    expect(planGroup(agent())).toBe('paused');
    // A round-up whose agents are paused shows paused; one with a failure nobody acted on, failed.
    const paused = { ...roundUp({ id: 'a1', parentId: 'r1', lastTurn: 'failed', limited: pause() }) };
    expect(roundUpStatus(roundUp({ lastTurn: 'completed' }), [paused], [])).toBe('paused');
    expect(roundUpStatus(roundUp({ lastTurn: 'failed', limited: pause() }), [], [])).toBe('paused');
    expect(roundUpStatus(roundUp({ lastTurn: 'completed' }), [paused, { ...paused, id: 'a2', limited: undefined, busy: true }], [])).toBe('working');
  });

  it('says when it resumes on the Plan bar, its rows, the status line and the summary', () => {
    expect(planLabel(agent(), { now: NOW })).toBe('Usage limit · Resumes 6:00 PM');
    expect(planBar([agent(), agent({ id: 'a2', title: 'Payments UI', limited: pause({ retryAt: SIX_PM + 5000 }) })], { now: NOW })).toMatchObject({
      dots: [{ group: 'paused' }, { group: 'paused' }],
      text: '2 agents are paused for the usage limit · resumes 6:00 PM',
      label: '2 paused',
    });
    expect(planBar([agent(), agent({ id: 'a2', status: 'working', limited: undefined })], { now: NOW }).text).toBe('Checkout API: Working');
    expect(statusLine(roundUp({ lastTurn: 'failed', limited: pause() }), NOW)).toEqual({ text: 'Paused · resumes 6:00 PM', tone: 'muted' });
    expect(statusLine(roundUp({ lastTurn: 'failed', limited: pause({ retryAt: undefined }) }), NOW).text).toBe('Paused · won’t auto-resume');
    expect(roundUpSummary(roundUp(), [agent(), agent({ id: 'a2', status: 'done' })], NOW)).toBe('1 paused');
  });
});

describe('the chat', () => {
  const ev = (seq: number, kind: string, data: unknown): KelpieEvent => ({ id: `r:${seq}`, runId: 'r', seq, ts: '2026-10-26T10:16:00.000Z', harness: 'claude-code', kind, data }) as KelpieEvent;
  const parts = (events: KelpieEvent[]) => buildChat(events).flatMap((i) => (i.role === 'assistant' ? i.parts : [])) as AssistantPart[];

  it("shows a turn stopped at the limit as a calm line, not the harness's error", () => {
    const limit = { resetsAt: '2026-10-26T12:30:00.000Z', retryAt: '2026-10-26T12:31:30.000Z', attempts: 0, window: 'five_hour' };
    const shown = parts([
      ev(0, 'message', { role: 'assistant', text: 'Looking at src/math.js first.' }),
      ev(1, 'message', { role: 'assistant', text: MESSAGE }),
      ev(2, 'turn.ended', { status: 'failed', error: MESSAGE, limit }),
    ]);
    expect(shown.map((p) => p.type)).toEqual(['text', 'limit']);
    expect(shown[1]).toEqual({ type: 'limit', limit, message: MESSAGE, ts: '2026-10-26T10:16:00.000Z' });
  });

  it('marks the turn Kelpie sent once the limit reset', () => {
    const shown = parts([ev(0, 'message', { role: 'user', text: 'Your usage limit has reset. Continue where you left off.', sent: true, source: 'kelpie', resumed: 'limit' })]);
    expect(shown).toEqual([{ type: 'resumed', ts: '2026-10-26T10:16:00.000Z' }]);
    // Other failures are still failures.
    expect(parts([ev(0, 'turn.ended', { status: 'failed', error: 'API Error: 500' })])[0]).toMatchObject({ type: 'notice', tone: 'error' });
  });
});

describe('notifications', () => {
  type S = Pick<RoundUp, 'id' | 'title' | 'busy' | 'lastTurn' | 'parentId' | 'limited'>;
  const agent = (over: Partial<S> = {}): S => ({ id: 'a1', title: 'Checkout API', busy: false, parentId: 'r1', ...over });
  // A notification says its time against the clock: pin it to NOW, whatever the real time of day.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('takes a turn that stopped at the limit for a pause, not a failure; and a paused session picking up for a resume', () => {
    const p = pause();
    expect(classifySession(agent({ busy: true, limited: p }), agent({ lastTurn: 'failed', limited: p }), 'needed', false)).toMatchObject({ kind: 'paused', until: SIX_PM, key: `paused:a1:${p.since}` });
    expect(classifySession(agent({ limited: p }), agent({ busy: true, lastTurn: 'failed' }), 'needed', false)).toMatchObject({ kind: 'resumed' });
    expect(classifySession(agent({ busy: true }), agent({ lastTurn: 'failed' }), 'needed', false)).toMatchObject({ kind: 'failed' });
    // Kelpie ran out of tries: that one needs the person.
    expect(classifySession(agent({ limited: p }), agent({ limited: { ...p, attempts: 12, retryAt: undefined, gaveUp: true } }), 'needed', false)).toMatchObject({ kind: 'gave-up', key: `gave-up:a1:${p.since}` });
  });

  it('chimes only for what needs the person: a pause is quiet, a resume only updates', () => {
    expect(loudness(['paused'])).toBe('quiet');
    expect(loudness(['paused', 'resumed'])).toBe('quiet');
    expect(loudness(['resumed'])).toBe('update');
    expect(loudness(['gave-up'])).toBe('alert');
    expect(loudness(['paused', 'approval'])).toBe('alert');
  });

  it('says until when, and that Kelpie resumes on its own', () => {
    const base = { roundUpId: 'r1', who: 'Checkout API' };
    const titleOf = () => 'Checkout';
    expect(summarize([{ ...base, sessionId: 'a1', kind: 'paused', key: 'p1', until: SIX_PM }], titleOf)).toMatchObject({ title: 'Checkout', body: 'Checkout API paused until 6:00 PM · Kelpie will resume automatically' });
    expect(
      summarize(
        [
          { ...base, sessionId: 'a1', kind: 'paused', key: 'p1', until: SIX_PM },
          { ...base, sessionId: 'a2', who: 'Payments UI', kind: 'paused', key: 'p2', until: SIX_PM + 5000 },
          { roundUpId: 'r2', sessionId: 'r2', who: 'Kelpie', kind: 'paused', key: 'p3', until: SIX_PM },
        ],
        titleOf,
      ),
    ).toMatchObject({ title: '2 round-ups', body: 'Paused until 6:00 PM · Kelpie will resume automatically' });
    expect(summarize([{ ...base, sessionId: 'a1', kind: 'resumed', key: 'r' }, { ...base, sessionId: 'a2', kind: 'resumed', key: 'r2' }], titleOf)?.body).toBe('2 agents resumed after the usage limit');
    // Another day's time says the day.
    const pausedUntil = (at: number) => summarize([{ ...base, sessionId: 'a1', kind: 'paused', key: 'p1', until: at }], titleOf)?.body;
    expect(pausedUntil(TOMORROW_9AM)).toBe('Checkout API paused until Tue 9:00 AM · Kelpie will resume automatically');
    // Just before midnight, a reset just after it is tomorrow's; just after midnight, the evening's is today's.
    vi.setSystemTime(new Date(2026, 9, 26, 23, 55));
    expect(pausedUntil(new Date(2026, 9, 27, 0, 5).getTime())).toMatch(/^Checkout API paused until Tue 12:05 AM ·/);
    vi.setSystemTime(new Date(2026, 9, 27, 0, 5));
    expect(pausedUntil(new Date(2026, 9, 27, 18, 0).getTime())).toMatch(/^Checkout API paused until 6:00 PM ·/);
    expect(pausedUntil(SIX_PM)).toMatch(/^Checkout API paused until Mon 6:00 PM ·/);
    expect(summarize([{ ...base, sessionId: 'a1', kind: 'gave-up', key: 'g' }], titleOf)).toMatchObject({ body: 'Checkout API is still at the usage limit: resume it when you can' });
    expect(summarize([{ ...base, sessionId: 'a1', kind: 'gave-up', key: 'g' }, { roundUpId: 'r2', sessionId: 'a2', who: 'B', kind: 'gave-up', key: 'g2' }], titleOf)?.title).toBe('2 round-ups need you');
  });

  describe('delivery', () => {
    let delivered: Delivery[];
    const settings: AttentionSettings = { enabled: true, sound: true, level: 'needed' };
    beforeEach(() => {
      delivered = [];
    });

    it('tells of a pause once and quietly, however often it is tried again; a resume only updates; giving up chimes', () => {
      let showing = false;
      const t = createAttention({ settings: () => settings, away: () => true, showing: () => showing, deliver: (d) => delivered.push(d) });
      t.sessions([{ id: 'r1', title: 'Checkout', busy: false }]);
      t.subAgents([agent()]);
      const p = pause();
      // Paused: one notification, without the chime.
      t.session(agent({ busy: true }));
      t.session(agent({ busy: true, limited: p }));
      t.session(agent({ lastTurn: 'failed', limited: p }));
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(delivered).toEqual([{ summary: expect.objectContaining({ body: 'Checkout API paused until 6:00 PM · Kelpie will resume automatically' }), alert: false }]);
      // A try that finds the limit still there: the same pause, no news.
      const later = { ...p, attempts: 1, retryAt: SIX_PM + 3_600_000 };
      t.session(agent({ busy: true, limited: p }));
      t.session(agent({ lastTurn: 'failed', limited: later }));
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(delivered).toHaveLength(1);
      // It picks up, with no notification on screen: nothing new appears (it may be the middle of the night).
      t.seen();
      t.session(agent({ busy: true }));
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(delivered).toHaveLength(1);
      // With one showing, it is updated in place, quietly.
      showing = true;
      t.session(agent({ busy: true, limited: { ...p, since: p.since + 1 } }));
      t.session(agent({ busy: true }));
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(delivered[1]).toEqual({ summary: expect.objectContaining({ body: 'Checkout API resumed after the usage limit' }), alert: false });
      // Kelpie gives up on it: the one notification that chimes.
      t.seen();
      showing = false;
      const stuck = { ...p, attempts: 12, retryAt: undefined, gaveUp: true };
      t.session(agent({ busy: true, limited: p }));
      t.session(agent({ busy: true, limited: stuck }));
      t.session(agent({ lastTurn: 'failed', limited: stuck }));
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(delivered[2]).toEqual({ summary: expect.objectContaining({ body: 'Checkout API is still at the usage limit: resume it when you can' }), alert: true });
      expect(delivered).toHaveLength(3);
    });
  });
});
