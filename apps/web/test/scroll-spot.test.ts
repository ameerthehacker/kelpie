import { describe, expect, it } from 'vitest';
import { belowView, headOf, scrollTopFor, scrollTopPast, spotAt, spotPast, TOP, type HeadEntry, type Span } from '../src/lib/scroll-spot.js';

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

describe('headOf', () => {
  const entry = (head: string | undefined, height = 0): HeadEntry => ({ head, height });

  it('counts the leading marked entries, covered by the sticky one', () => {
    expect(headOf([entry(''), entry('sticky', 37), entry(undefined), entry(undefined)])).toEqual({ skip: 2, cover: 37 });
  });

  it('is nothing for a chat without a head, and covers nothing without a sticky bar', () => {
    expect(headOf([])).toEqual({ skip: 0, cover: 0 });
    expect(headOf([entry(undefined), entry('sticky', 37)])).toEqual({ skip: 0, cover: 0 });
    expect(headOf([entry(''), entry(undefined)])).toEqual({ skip: 1, cover: 0 });
  });

  it('stops at the first unmarked entry, reading no height past it', () => {
    const read: number[] = [];
    const entries = [entry(''), entry(undefined), entry('sticky', 37)].map((e, i) => ({
      head: e.head,
      get height() {
        read.push(i);
        return e.height;
      },
    }));
    expect(headOf(entries)).toEqual({ skip: 1, cover: 0 });
    expect(read).toEqual([]);
  });
});

describe('spotPast', () => {
  // A title [0,120], the sticky bar [136,173] (37px), then entries 100px tall every 120px from 200.
  const head = { skip: 2, cover: 37 };
  const at = (title: number, entry: number, gap = 20) => (i: number): Span =>
    i === 0 ? { top: 0, height: title } : i === 1 ? { top: title + 16, height: 37 } : { top: title + 80 + (i - 2) * (entry + gap), height: entry };
  const before = at(120, 100);

  it('measures from under the sticky bar, past the head', () => {
    // Scrolled 500: the bar stuck over [500,537], whose bottom edge is in the third entry past the head, [440,540].
    expect(spotPast(head, 500, 12, before)).toEqual({ index: 2, into: (537 - 440) / 100 });
  });

  it('is the top while the edge under the bar is still above the first entry', () => {
    expect(spotPast(head, 0, 12, before)).toBe(TOP);
    expect(spotPast(head, 150, 12, before)).toBe(TOP);
    expect(scrollTopPast(TOP, head, before, { scrollTop: 900, top: 0, scrollHeight: 3000 })).toBe(0);
  });

  it('round-trips a spot in a gap (a negative into) after the chat reflows', () => {
    // The edge under the bar at 310 falls in the gap [300,320] before the second entry past the head: into < 0.
    const spot = spotPast(head, 310 - 37, 12, before)!;
    expect(spot.index).toBe(1);
    expect(spot.into).toBeLessThan(0);
    // Narrower now: the title wraps, entries are taller.
    const after = at(170, 160, 30);
    const top = scrollTopPast(spot, head, after, { scrollTop: 0, top: 0, scrollHeight: 6000 });
    expect(spotPast(head, top, 12, after)).toEqual(spot);
  });

  it('round-trips a spot inside an entry, and none without a head', () => {
    const spot = spotPast(head, 1000, 12, before)!;
    const top = scrollTopPast(spot, head, before, { scrollTop: 0, top: 0, scrollHeight: 3000 });
    expect(top).toBeCloseTo(1000);
    const bare = { skip: 0, cover: 0 };
    const plain = (i: number): Span => ({ top: i * 120, height: 100 });
    expect(spotPast(bare, 150, 10, plain)).toEqual(spotAt(150, 10, plain));
  });
});
