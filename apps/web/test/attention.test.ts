import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingApproval } from '../src/lib/approvals.js';
import {
  ALERT_COOLDOWN_MS,
  BUNDLE_MS,
  classifySession,
  createAttention,
  endedTurn,
  newApprovals,
  summarize,
  type Attention,
  type AttentionSettings,
  type Delivery,
} from '../src/lib/attention.js';
import type { RoundUp } from '../src/lib/round-ups.js';

type S = Pick<RoundUp, 'id' | 'title' | 'busy' | 'lastTurn' | 'parentId'>;
const top = (over: Partial<S> = {}): S => ({ id: 'r1', title: 'Fix login', busy: false, ...over });
const agent = (over: Partial<S> = {}): S => ({ id: 'a1', title: 'Checkout API', busy: false, parentId: 'r1', ...over });

let seq = 0;
const ask = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  roundUpId: 'r1',
  sessionId: 'a1',
  agentTitle: 'Checkout API',
  requestId: `q${++seq}`,
  tool: 'Bash',
  title: 'pnpm install',
  input: {},
  ts: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('classifying', () => {
  it('sees a turn end only when busy turns off, and not when the person interrupted it', () => {
    expect(endedTurn(top({ busy: true }), top({ lastTurn: 'completed' }))).toBe('completed');
    expect(endedTurn(top({ busy: true }), top({ lastTurn: 'failed' }))).toBe('failed');
    expect(endedTurn(top({ busy: true }), top({ lastTurn: 'interrupted' }))).toBeUndefined();
    expect(endedTurn(top({ busy: true }), top({ busy: true, lastTurn: 'completed' }))).toBeUndefined();
    expect(endedTurn(top({ lastTurn: 'completed' }), top({ lastTurn: 'completed' }))).toBeUndefined();
    expect(endedTurn(undefined, top({ lastTurn: 'completed' }))).toBeUndefined();
  });

  it("treats Kelpie's finished turn as a reply, and a sub-agent's only at the 'all' level", () => {
    expect(classifySession(top({ busy: true }), top({ lastTurn: 'completed' }), 'needed')).toMatchObject({ kind: 'reply', roundUpId: 'r1', who: 'Kelpie' });
    expect(classifySession(agent({ busy: true }), agent({ lastTurn: 'completed' }), 'needed')).toBeUndefined();
    expect(classifySession(agent({ busy: true }), agent({ lastTurn: 'completed' }), 'all')).toMatchObject({ kind: 'finished', roundUpId: 'r1', sessionId: 'a1' });
  });

  it('always reports failures, from Kelpie or an agent', () => {
    expect(classifySession(top({ busy: true }), top({ lastTurn: 'failed' }), 'needed')).toMatchObject({ kind: 'failed', sessionId: 'r1' });
    expect(classifySession(agent({ busy: true }), agent({ lastTurn: 'failed' }), 'needed')).toMatchObject({ kind: 'failed', sessionId: 'a1', roundUpId: 'r1' });
  });

  it('tells plans from approvals, and skips the ones already known', () => {
    const a = ask();
    const plan = ask({ tool: 'ExitPlanMode', sessionId: 'r1', agentTitle: 'Kelpie' });
    expect(newApprovals(new Set([`a1:${a.requestId}`]), [a, plan]).map((i) => i.kind)).toEqual(['plan']);
  });
});

describe('summarizing', () => {
  const titles: Record<string, string> = { r1: 'Fix login', r2: 'Billing' };
  const titleOf = (id: string) => titles[id] ?? 'New round-up';
  const item = (kind: Attention['kind'], over: Partial<Attention> = {}): Attention => ({ kind, roundUpId: 'r1', sessionId: 'a1', who: 'Checkout API', key: `${kind}:${Math.random()}`, ...over });

  it('names one round-up, counts the agents asking, and opens the round-up', () => {
    const s = summarize([item('approval'), item('approval', { sessionId: 'a2' }), item('approval', { sessionId: 'a3' }), item('reply', { sessionId: 'r1', who: 'Kelpie' })], titleOf);
    expect(s).toEqual({ title: 'Fix login', body: '3 agents need approval · Kelpie replied', path: '/r/r1' });
  });

  it('counts one agent asking twice once', () => {
    expect(summarize([item('approval'), item('approval')], titleOf)?.body).toBe('Checkout API needs approval');
  });

  it('sends approvals across round-ups to the approvals queue', () => {
    const s = summarize([item('reply', { roundUpId: 'r2' }), item('approval'), item('approval', { roundUpId: 'r2', sessionId: 'b1' })], titleOf);
    expect(s).toEqual({ title: '2 round-ups need you', body: '2 agents need approval · Kelpie replied in Billing', path: '/approvals' });
  });

  it('leads with the most pressing thing', () => {
    expect(summarize([item('finished'), item('failed', { sessionId: 'r1', roundUpId: 'r1' })], titleOf)).toEqual({
      title: 'Fix login',
      body: 'Kelpie’s turn failed · Checkout API finished',
      path: '/r/r1',
    });
    expect(summarize([item('plan', { roundUpId: 'r2' }), item('reply')], titleOf)?.path).toBe('/r/r2');
    expect(summarize([], titleOf)).toBeUndefined();
  });
});

describe('the tracker', () => {
  let settings: AttentionSettings;
  let away: boolean;
  let delivered: Delivery[];
  const make = () =>
    createAttention({
      settings: () => settings,
      away: () => away,
      deliver: (d) => delivered.push(d),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    settings = { enabled: true, sound: true, level: 'needed' };
    away = true;
    delivered = [];
  });
  afterEach(() => vi.useRealTimers());

  /** A seeded tracker: the stream's first snapshots are the state of things, not news. */
  const seeded = (sessions: S[] = [top()], approvals: PendingApproval[] = []) => {
    const t = make();
    t.sessions(sessions);
    t.approvalsSnapshot(approvals);
    return t;
  };

  it('does not notify for what is already there when the stream connects', () => {
    const t = make();
    t.sessions([top({ busy: true })]);
    t.approvalsSnapshot([ask()]);
    vi.advanceTimersByTime(BUNDLE_MS);
    expect(delivered).toEqual([]);
    t.session(top({ lastTurn: 'completed' }));
    vi.advanceTimersByTime(BUNDLE_MS);
    expect(delivered.map((d) => d.summary.body)).toEqual(['Kelpie replied']);
  });

  it('bundles close-together things into one notification after the window', () => {
    const t = seeded();
    t.approvals('r1', [ask({ sessionId: 'a1' })]);
    vi.advanceTimersByTime(1_000);
    t.approvals('r1', [ask({ sessionId: 'a1' }), ask({ sessionId: 'a2' }), ask({ sessionId: 'a3' })]);
    vi.advanceTimersByTime(BUNDLE_MS - 1_001);
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(delivered).toEqual([{ summary: { title: 'Fix login', body: '3 agents need approval', path: '/r/r1' }, alert: true }]);
  });

  it('does not notify again for an approval that is still open', () => {
    const a = ask();
    const t = seeded();
    t.approvals('r1', [a]);
    vi.advanceTimersByTime(BUNDLE_MS);
    t.approvals('r1', [a]);
    vi.advanceTimersByTime(BUNDLE_MS);
    expect(delivered).toHaveLength(1);
  });

  it('drops what was answered before the bundle went out', () => {
    const t = seeded();
    t.approvals('r1', [ask()]);
    t.approvals('r1', []);
    vi.advanceTimersByTime(BUNDLE_MS);
    expect(delivered).toEqual([]);
  });

  it('alerts at most once per cooldown; bundles in between update the notification quietly', () => {
    const t = seeded([top(), top({ id: 'r2', title: 'Billing' })]);
    t.approvals('r1', [ask()]);
    vi.advanceTimersByTime(BUNDLE_MS);
    t.session(top({ busy: true }));
    t.session(top({ lastTurn: 'completed' }));
    vi.advanceTimersByTime(BUNDLE_MS);
    vi.advanceTimersByTime(ALERT_COOLDOWN_MS - 2 * BUNDLE_MS);
    t.session(top({ id: 'r2', title: 'Billing', busy: true }));
    t.session(top({ id: 'r2', title: 'Billing', lastTurn: 'completed' }));
    vi.advanceTimersByTime(BUNDLE_MS);
    expect(delivered.map((d) => [d.summary.body, d.alert])).toEqual([
      ['Checkout API needs approval', true],
      // The tray holds one notification: each covers everything since the person last looked.
      ['Checkout API needs approval · Kelpie replied', false],
      ['Checkout API needs approval · Kelpie replied in 2 round-ups', true],
    ]);
  });

  it('only notifies while the person is away, and forgets what they have seen', () => {
    const t = seeded();
    away = false;
    t.approvals('r1', [ask()]);
    vi.advanceTimersByTime(BUNDLE_MS);
    expect(delivered).toEqual([]);
    expect(t.unseen()).toEqual([]);

    away = true;
    const listener = vi.fn();
    t.subscribe(listener);
    t.session(top({ busy: true }));
    t.session(top({ lastTurn: 'completed' }));
    vi.advanceTimersByTime(BUNDLE_MS);
    expect(t.unseen().map((i) => i.kind)).toEqual(['reply']);
    t.seen();
    expect(t.unseen()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stays quiet when turned off, and for sub-agents finishing unless asked', () => {
    const t = seeded([top()]);
    t.session(agent({ busy: true }));
    t.session(agent({ lastTurn: 'completed' }));
    vi.advanceTimersByTime(BUNDLE_MS);
    expect(delivered).toEqual([]);

    settings = { ...settings, level: 'all' };
    t.session(agent({ busy: true }));
    t.session(agent({ lastTurn: 'completed' }));
    vi.advanceTimersByTime(BUNDLE_MS);
    expect(delivered.map((d) => d.summary.body)).toEqual(['Checkout API finished']);

    settings = { ...settings, enabled: false };
    t.approvals('r1', [ask()]);
    vi.advanceTimersByTime(BUNDLE_MS);
    expect(delivered).toHaveLength(1);
  });

  it('bundles a wave of failures, as when a usage limit hits every agent', () => {
    const t = seeded([top()]);
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      t.session(agent({ id, busy: true }));
      t.session(agent({ id, lastTurn: 'failed' }));
    }
    vi.advanceTimersByTime(BUNDLE_MS);
    expect(delivered.map((d) => [d.summary.body, d.alert])).toEqual([['4 agents failed', true]]);
  });
});
