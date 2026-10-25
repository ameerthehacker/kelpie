import { describe, expect, it, vi } from 'vitest';
import { parseSettings } from '../src/lib/attention.js';
import { createTabs, type Locks, type TabChannel } from '../src/lib/tabs.js';

describe('notification settings', () => {
  it('are off by default, at the "needed" level, with the sound', () => {
    expect(parseSettings(null)).toEqual({ enabled: false, sound: true, level: 'needed' });
  });

  it('keep what was stored, and fall back for anything missing or malformed', () => {
    expect(parseSettings('{"enabled":true,"sound":false,"level":"all"}')).toEqual({ enabled: true, sound: false, level: 'all' });
    expect(parseSettings('{"enabled":"yes","level":"loud"}')).toEqual({ enabled: false, sound: true, level: 'needed' });
    expect(parseSettings('{"enabled":true}')).toEqual({ enabled: true, sound: true, level: 'needed' });
    expect(parseSettings('null')).toEqual({ enabled: false, sound: true, level: 'needed' });
    expect(parseSettings('{not json')).toEqual({ enabled: false, sound: true, level: 'needed' });
  });
});

describe('tabs', () => {
  /** BroadcastChannel between tabs of one origin: every tab hears a message but its sender. */
  const bus = () => {
    const tabs: { listener?: (e: { data: never }) => void }[] = [];
    return (): TabChannel => {
      const me: (typeof tabs)[number] = {};
      tabs.push(me);
      return {
        postMessage: (data) => tabs.forEach((t) => t !== me && t.listener?.({ data: data as never })),
        addEventListener: (_, listener) => (me.listener = listener),
      };
    };
  };
  /** Web Locks: the first tab to ask holds it; the next gets it once that one is gone. */
  const lockManager = () => {
    const queue: (() => void)[] = [];
    return {
      locks: {
        request: (_name, granted) => {
          queue.push(() => void granted());
          if (queue.length === 1) queue[0]!();
          return new Promise(() => {});
        },
      } satisfies Locks,
      closeFirst: () => {
        queue.shift();
        queue[0]?.();
      },
    };
  };

  it('pick one tab to notify, and hand it on when that tab closes', () => {
    const { locks, closeFirst } = lockManager();
    const channel = bus();
    const a = createTabs({ channel: channel(), locks, id: 'a' });
    const b = createTabs({ channel: channel(), locks, id: 'b' });
    expect([a.leader(), b.leader()]).toEqual([true, false]);
    closeFirst();
    expect(b.leader()).toBe(true);
  });

  it('every tab notifies without Web Locks, as a lone tab would', () => {
    expect(createTabs({ id: 'a' }).leader()).toBe(true);
  });

  it('tell each other where the person is, a new tab included', () => {
    const channel = bus();
    const a = createTabs({ channel: channel(), id: 'a' });
    const b = createTabs({ channel: channel(), id: 'b' });
    a.presence(true);
    expect([a.elsewhere(), b.elsewhere()]).toEqual([false, true]);
    // A tab opened later asks, and the one the person is in answers.
    const c = createTabs({ channel: channel(), id: 'c' });
    expect(c.elsewhere()).toBe(true);
    a.presence(false);
    expect([b.elsewhere(), c.elsewhere()]).toEqual([false, false]);
  });

  it('share that the person has looked', () => {
    const channel = bus();
    const a = createTabs({ channel: channel(), id: 'a' });
    const b = createTabs({ channel: channel(), id: 'b' });
    const seenInB = vi.fn();
    const seenInA = vi.fn();
    b.onSeen(seenInB);
    a.onSeen(seenInA);
    a.seen();
    expect(seenInB).toHaveBeenCalledOnce();
    expect(seenInA).not.toHaveBeenCalled();
  });
});
