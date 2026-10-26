import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingApproval } from '../src/lib/approvals.js';
import {
  ALERT_COOLDOWN_MS,
  BUNDLE_MS,
  classifySession,
  createAttention,
  endedTurn,
  fullyIdle,
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

  it("treats Kelpie's finished turn as a reply once all is idle, and a sub-agent's only at the 'all' level", () => {
    expect(classifySession(top({ busy: true }), top({ lastTurn: 'completed' }), 'needed', true)).toMatchObject({ kind: 'reply', roundUpId: 'r1', who: 'Kelpie' });
    expect(classifySession(top({ busy: true }), top({ lastTurn: 'completed' }), 'needed', false)).toBeUndefined();
    expect(classifySession(top({ busy: true }), top({ lastTurn: 'completed' }), 'all', false)).toBeUndefined();
    expect(classifySession(agent({ busy: true }), agent({ lastTurn: 'completed' }), 'needed', true)).toBeUndefined();
    expect(classifySession(agent({ busy: true }), agent({ lastTurn: 'completed' }), 'all', false)).toMatchObject({ kind: 'finished', roundUpId: 'r1', sessionId: 'a1' });
  });

  it('always reports failures, from Kelpie or an agent, whatever else is running', () => {
    expect(classifySession(top({ busy: true }), top({ lastTurn: 'failed' }), 'needed', false)).toMatchObject({ kind: 'failed', sessionId: 'r1' });
    expect(classifySession(agent({ busy: true }), agent({ lastTurn: 'failed' }), 'needed', false)).toMatchObject({ kind: 'failed', sessionId: 'a1', roundUpId: 'r1' });
  });

  it("sees a round-up fully idle only when neither Kelpie nor any of its agents is busy", () => {
    expect(fullyIdle('r1', [top(), agent(), agent({ id: 'b1', parentId: 'r2', busy: true })])).toBe(true);
    expect(fullyIdle('r1', [top({ busy: true }), agent()])).toBe(false);
    expect(fullyIdle('r1', [top(), agent(), agent({ id: 'a2', busy: true })])).toBe(false);
  });

  it('tells plans from approvals, and skips the ones already known', () => {
    const a = ask();
    const plan = ask({ tool: 'ExitPlanMode', sessionId: 'r1', agentTitle: 'Kelpie' });
    expect(newApprovals(new Set([`a1:${a.requestId}`]), [a, plan]).map((i) => i.kind)).toEqual(['plan']);
  });

  it('tells questions from approvals, the orchestrator asking as Kelpie', () => {
    const questions = [{ question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] }];
    const q = ask({ tool: 'AskUserQuestion', questions });
    const mine = ask({ tool: 'AskUserQuestion', questions, sessionId: 'r1', agentTitle: 'Fix login' });
    expect(newApprovals(new Set(), [q, mine]).map((i) => [i.kind, i.who])).toEqual([
      ['question', 'Checkout API'],
      ['question', 'Kelpie'],
    ]);
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

  it('says who has questions, after approvals and before plans', () => {
    expect(summarize([item('question')], titleOf)).toEqual({ title: 'Fix login', body: 'Checkout API has a question', path: '/r/r1' });
    expect(summarize([item('plan'), item('question', { sessionId: 'r1', who: 'Kelpie' }), item('question', { sessionId: 'r1', who: 'Kelpie' })], titleOf)?.body).toBe('Kelpie has questions · A plan is ready for review');
    expect(summarize([item('question'), item('question', { sessionId: 'a2' }), item('approval')], titleOf)?.body).toBe('Checkout API needs approval · 2 agents have questions');
    expect(summarize([item('question'), item('question', { roundUpId: 'r2', sessionId: 'b1' })], titleOf)?.path).toBe('/approvals');
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
  let inTray: boolean;
  let delivered: Delivery[];
  const make = () =>
    createAttention({
      settings: () => settings,
      away: () => away,
      showing: () => inTray,
      deliver: (d) => delivered.push(d),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    settings = { enabled: true, sound: true, level: 'needed' };
    away = true;
    inTray = true;
    delivered = [];
  });
  afterEach(() => vi.useRealTimers());

  /** A seeded tracker: the stream's first snapshots are the state of things, not news. */
  const seeded = (sessions: S[] = [top()], approvals: PendingApproval[] = [], subAgents: S[] = []) => {
    const t = make();
    t.sessions(sessions);
    t.subAgents(subAgents);
    t.approvalsSnapshot(approvals);
    return t;
  };
  const bodies = () => delivered.map((d) => d.summary.body);
  /** A turn, start to end. */
  const turn = (t: ReturnType<typeof make>, s: S, lastTurn: S['lastTurn'] = 'completed') => {
    t.session({ ...s, busy: true });
    t.session({ ...s, busy: false, lastTurn });
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

  it('notifies for a question, and drops it once answered', () => {
    const questions = [{ question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] }];
    const t = seeded();
    const q = ask({ tool: 'AskUserQuestion', questions });
    t.approvals('r1', [q]);
    vi.advanceTimersByTime(BUNDLE_MS);
    expect(bodies()).toEqual(['Checkout API has a question']);
    expect(t.unseen().map((i) => i.kind)).toEqual(['question']);
    // Answered (anywhere): no longer news the next time the notification is updated.
    t.approvals('r1', []);
    t.session(top({ busy: true }));
    t.session(top({ lastTurn: 'completed' }));
    vi.advanceTimersByTime(BUNDLE_MS);
    expect(bodies().at(-1)).toBe('Kelpie replied');
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

  describe("Kelpie's turns", () => {
    it('stay quiet while its agents work, and notify once everything has stopped', () => {
      const t = seeded();
      // "I've started 3 agents": they are working as its turn ends.
      t.session(top({ busy: true }));
      for (const id of ['a1', 'a2', 'a3']) t.session(agent({ id, busy: true }));
      t.session(top({ lastTurn: 'completed' }));
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(delivered).toEqual([]);

      // One reports in, Kelpie takes a turn on it while the others work.
      t.session(agent({ id: 'a1', lastTurn: 'completed' }));
      turn(t, top());
      t.session(agent({ id: 'a2', lastTurn: 'completed' }));
      turn(t, top());
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(delivered).toEqual([]);

      // The last one: Kelpie's roll-up is the person's.
      t.session(agent({ id: 'a3', lastTurn: 'completed' }));
      expect(delivered).toEqual([]);
      turn(t, top());
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(bodies()).toEqual(['Kelpie replied']);
    });

    it('drop a reply when Kelpie or an agent starts again within the bundle window', () => {
      const t = seeded();
      turn(t, top());
      t.session(agent({ busy: true }));
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(delivered).toEqual([]);
    });

    it("only count the round-up's own agents", () => {
      const t = seeded([top(), top({ id: 'r2', title: 'Billing' })], [], [agent({ id: 'b1', parentId: 'r2', busy: true })]);
      turn(t, top());
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(bodies()).toEqual(['Kelpie replied']);
    });

    it('do not hide approvals, plans or failures raised while agents work', () => {
      const t = seeded([top()], [], [agent({ id: 'a2', busy: true }), agent({ id: 'a3', busy: true })]);
      t.approvals('r1', [ask({ sessionId: 'a2' }), ask({ tool: 'ExitPlanMode', sessionId: 'r1', agentTitle: 'Kelpie' })]);
      turn(t, agent({ id: 'a3' }), 'failed');
      turn(t, top(), 'failed');
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(bodies()).toEqual(['Checkout API needs approval · A plan is ready for review · 2 agents failed']);
    });

    it("at the 'all' level, notify for every agent finishing but not for the turns in between", () => {
      settings = { ...settings, level: 'all' };
      const t = seeded([top()], [], [agent({ id: 'a1', busy: true }), agent({ id: 'a2', busy: true })]);
      t.session(agent({ id: 'a1', lastTurn: 'completed' }));
      turn(t, top());
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(bodies()).toEqual(['Checkout API finished']);
      t.session(agent({ id: 'a2', title: 'Billing API', lastTurn: 'completed' }));
      turn(t, top());
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(bodies()[1]).toBe('Kelpie replied · 2 agents finished');
    });

    it('forget a deleted agent: it no longer keeps the round-up working', () => {
      const t = seeded([top()], [], [agent({ busy: true })]);
      t.deleted('a1');
      turn(t, top());
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(bodies()).toEqual(['Kelpie replied']);
    });
  });

  describe('reconnecting', () => {
    it('takes every snapshot as the state of things: what changed while disconnected is not news', () => {
      const t = seeded([top({ busy: true }), top({ id: 'r2', title: 'Billing' })], [], [agent({ busy: true })]);
      // The laptop slept: the round-up finished and approvals were raised meanwhile.
      t.sessions([top({ lastTurn: 'completed' }), top({ id: 'r2', title: 'Billing' })]);
      t.subAgents([agent({ lastTurn: 'completed' })]);
      t.approvalsSnapshot([ask(), ask({ roundUpId: 'r2', sessionId: 'b1' })]);
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(delivered).toEqual([]);

      // Live updates after it are news as before.
      t.approvals('r2', [ask({ roundUpId: 'r2', sessionId: 'b1', requestId: 'fresh' })]);
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(delivered.map((d) => d.summary.title)).toEqual(['Billing']);
    });

    it("drops the agents' old state, and takes theirs from the sub-agents snapshot", () => {
      settings = { ...settings, level: 'all' };
      const t = seeded([top()], [], [agent({ busy: true }), agent({ id: 'a2', busy: true })]);
      // a1 stopped while disconnected; a2 is still working.
      t.sessions([top()]);
      t.subAgents([agent({ lastTurn: 'completed' }), agent({ id: 'a2', busy: true })]);
      turn(t, top());
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(delivered).toEqual([]);
      t.session(agent({ id: 'a2', title: 'Billing API', lastTurn: 'completed' }));
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(bodies()).toEqual(['Billing API finished']);
    });

    it('forgets agents an old daemon does not snapshot, rather than wait on them', () => {
      const t = seeded([top()], [], [agent({ busy: true })]);
      t.sessions([top()]);
      turn(t, top());
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(bodies()).toEqual(['Kelpie replied']);
    });
  });

  describe('seen and the tray', () => {
    it('starts over once the person has looked, and drops what was about a deleted round-up', () => {
      const t = seeded([top(), top({ id: 'r2', title: 'Billing' })]);
      turn(t, top());
      turn(t, top({ id: 'r2', title: 'Billing' }));
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(t.unseen()).toHaveLength(2);
      t.deleted('r2');
      expect(t.unseen().map((i) => i.roundUpId)).toEqual(['r1']);
      t.seen();
      expect(t.unseen()).toEqual([]);

      vi.advanceTimersByTime(ALERT_COOLDOWN_MS);
      t.approvals('r1', [ask()]);
      vi.advanceTimersByTime(BUNDLE_MS);
      // What they saw is not repeated.
      expect(delivered.at(-1)).toEqual({ summary: { title: 'Fix login', body: 'Checkout API needs approval', path: '/r/r1' }, alert: true });
    });

    it('holds a bundle back until the cooldown when there is no notification left to update quietly', () => {
      const t = seeded();
      t.approvals('r1', [ask()]);
      vi.advanceTimersByTime(BUNDLE_MS);
      inTray = false; // dismissed
      turn(t, top());
      vi.advanceTimersByTime(BUNDLE_MS);
      expect(delivered).toHaveLength(1);
      // The cooldown runs from the first banner, which went out a bundle window ago.
      vi.advanceTimersByTime(ALERT_COOLDOWN_MS - BUNDLE_MS - 1);
      expect(delivered).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(delivered.map((d) => [d.summary.body, d.alert])).toEqual([
        ['Checkout API needs approval', true],
        ['Checkout API needs approval · Kelpie replied', true],
      ]);
    });

    it('drops a held-back banner once the person has looked', () => {
      const t = seeded();
      t.approvals('r1', [ask()]);
      vi.advanceTimersByTime(BUNDLE_MS);
      inTray = false;
      turn(t, top());
      vi.advanceTimersByTime(BUNDLE_MS);
      t.seen();
      vi.advanceTimersByTime(ALERT_COOLDOWN_MS);
      expect(delivered).toHaveLength(1);
    });
  });
});
