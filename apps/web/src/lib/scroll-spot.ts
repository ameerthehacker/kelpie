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
