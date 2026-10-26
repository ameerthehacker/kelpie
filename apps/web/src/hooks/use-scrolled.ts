import { useEffect, useState } from 'react';

/** The nearest ancestor that scrolls `el` vertically, if any (else the page itself). */
function scrollerOf(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === 'auto' || overflowY === 'scroll') return p;
  }
  return null;
}

/**
 * Whether a `sticky top-0` element is stuck to its scroller's top edge, content scrolling under
 * it. Seen through its scroller's view shrunk by a pixel at the top: stuck, it is cut by that pixel.
 */
export function useStuck(el: Element | null): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.rootBounds) return;
        setStuck(entry.intersectionRatio < 1 && entry.boundingClientRect.top < entry.rootBounds.top);
      },
      { root: scrollerOf(el), rootMargin: '-1px 0px 0px 0px', threshold: [1] },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return stuck;
}

/** Whether `el` has scrolled up out of its scroller's view, entirely above its top edge. */
export function useScrolledPast(el: Element | null): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.rootBounds) return;
        setPast(!entry.isIntersecting && entry.boundingClientRect.bottom <= entry.rootBounds.top);
      },
      { root: scrollerOf(el), threshold: [0] },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return past;
}
