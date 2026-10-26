import { describe, expect, it } from 'vitest';
import { belowView, scrollTopFor, spotAt, type Span } from '../src/lib/scroll-spot.js';

// Entries 100px tall with 20px gaps, the first at 0: [0,100], [120,220], [240,340], …
const stack = (count: number) => {
  const asked: number[] = [];
  const span = (i: number): Span => {
    asked.push(i);
    return { top: i * 120, height: 100 };
  };
  return { count, span, asked };
};

describe('spotAt', () => {
  it('finds the entry at the top edge and how far into it', () => {
    const { count, span } = stack(10);
    expect(spotAt(0, count, span)).toEqual({ index: 0, into: 0 });
    expect(spotAt(150, count, span)).toEqual({ index: 1, into: 0.3 });
    expect(spotAt(339, count, span)).toEqual({ index: 2, into: 0.99 });
  });

  it('takes the next entry when the top edge falls in a gap', () => {
    const { count, span } = stack(10);
    expect(spotAt(105, count, span)).toEqual({ index: 1, into: -0.15 });
  });

  it('has no spot past the last entry, or with none', () => {
    expect(spotAt(5000, stack(10).count, stack(10).span)).toBeUndefined();
    expect(spotAt(0, 0, stack(0).span)).toBeUndefined();
  });

  it('measures few entries in a long chat', () => {
    const s = stack(1000);
    expect(spotAt(60_000, s.count, s.span)?.index).toBe(500);
    expect(s.asked.length).toBeLessThan(15);
  });

  it('copes with an entry of no height', () => {
    expect(spotAt(0, 1, () => ({ top: -10, height: 0 }))).toBeUndefined();
    expect(spotAt(0, 1, () => ({ top: 0, height: 0 }))).toBeUndefined();
    expect(spotAt(0, 2, (i) => (i ? { top: 5, height: 0 } : { top: -10, height: 5 }))).toEqual({ index: 1, into: 0 });
  });
});

describe('scrollTopFor', () => {
  const view = { scrollTop: 400, top: 50, scrollHeight: 3000 };

  it('puts the spot back at the top edge', () => {
    // The entry's top is 250px below the view's: scroll that far, plus 30% of its height.
    expect(scrollTopFor({ index: 3, into: 0.3 }, { top: 300, height: 200 }, view)).toBe(400 + 250 + 60);
  });

  it('round-trips with spotAt after the chat reflows', () => {
    const before = stack(10);
    const spot = spotAt(500, before.count, before.span)!;
    // Wider now: every entry is 60px tall and they sit 70px apart, the view still at 0 scrolled.
    const after = (i: number): Span => ({ top: i * 70, height: 60 });
    const top = scrollTopFor(spot, after(spot.index), { scrollTop: 0, top: 0, scrollHeight: 700 });
    expect(spotAt(top, 10, after)).toEqual(spot);
  });

  it('goes as far down as it can while the entry has not arrived', () => {
    expect(scrollTopFor({ index: 40, into: 0 }, undefined, view)).toBe(3000);
  });
});

describe('belowView', () => {
  it('is the distance left to scroll', () => {
    expect(belowView({ scrollHeight: 2000, scrollTop: 1200, clientHeight: 700 })).toBe(100);
    expect(belowView({ scrollHeight: 700, scrollTop: 0, clientHeight: 700 })).toBe(0);
  });
});
