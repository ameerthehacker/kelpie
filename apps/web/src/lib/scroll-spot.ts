/**
 * Where the person left a chat they had scrolled up in: the entry at the top of the view and how
 * far into it. Not a scroll offset: the chat may come back wider or narrower (the agent pane was
 * open, say), and everything above would have reflowed.
 */
export interface Spot {
  index: number;
  /** How far down the entry the view's top edge was, as a fraction of its height. */
  into: number;
}

/** An entry's box, in the same coordinates as the view's top edge. */
export interface Span {
  top: number;
  height: number;
}

/**
 * The spot at the view's top edge: the first of `count` entries, stacked top to bottom, that
 * reaches below it. `span` is asked for as few entries as a binary search needs.
 */
export function spotAt(viewTop: number, count: number, span: (index: number) => Span): Spot | undefined {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = span(mid);
    if (r.top + r.height > viewTop) hi = mid;
    else lo = mid + 1;
  }
  if (lo === count) return;
  const r = span(lo);
  return { index: lo, into: r.height ? (viewTop - r.top) / r.height : 0 };
}

/**
 * The scroll offset that puts `spot` back at the view's top edge, given where its entry is now,
 * or as far down as the chat goes while that entry isn't there (yet).
 */
export function scrollTopFor(spot: Spot, entry: Span | undefined, view: { scrollTop: number; top: number; scrollHeight: number }): number {
  if (!entry) return view.scrollHeight;
  return view.scrollTop + entry.top - view.top + spot.into * entry.height;
}

/** How far the view is from the bottom of what it scrolls. */
export function belowView(view: { scrollHeight: number; scrollTop: number; clientHeight: number }): number {
  return view.scrollHeight - view.scrollTop - view.clientHeight;
}

/** One of a chat's entries as its head sees it: marked (`data-chat-head`, "sticky" for its bar), and its height. */
export interface HeadEntry {
  head: string | undefined;
  height: number;
}

/**
 * What leads the chat: how many entries (the title, the tabs), and the height of the bar stuck to
 * the top that the rest scroll under. Only the leading run of marked entries counts; `height` is
 * read for the sticky one alone.
 */
export interface Head {
  skip: number;
  cover: number;
}

export function headOf(entries: Iterable<HeadEntry>): Head {
  let skip = 0;
  let cover = 0;
  for (const e of entries) {
    if (e.head === undefined) break;
    skip++;
    if (e.head === 'sticky') cover = e.height;
  }
  return { skip, cover };
}

/** The view's top edge is up in the head, above every entry: put back at the very top. */
export const TOP: Spot = { index: -1, into: 0 };

/**
 * The spot past the chat's head, at its sticky bar's bottom edge (stuck, the bar's own box would
 * read as the entry at the top). `index` counts from the first entry after the head. Above that
 * entry it is TOP: an `into` there would be in the first entry's units, and wrong once it reflows.
 */
export function spotPast(head: Head, viewTop: number, count: number, span: (index: number) => Span): Spot | undefined {
  const spot = spotAt(viewTop + head.cover, count - head.skip, (i) => span(head.skip + i));
  return spot && spot.index === 0 && spot.into < 0 ? TOP : spot;
}

/** The scroll offset that puts a `spotPast` back under the sticky bar; `entry` is asked by index from the very first entry. */
export function scrollTopPast(spot: Spot, head: Head, entry: (index: number) => Span | undefined, view: { scrollTop: number; top: number; scrollHeight: number }): number {
  if (spot.index < 0) return 0;
  return scrollTopFor(spot, entry(head.skip + spot.index), { ...view, top: view.top + head.cover });
}
