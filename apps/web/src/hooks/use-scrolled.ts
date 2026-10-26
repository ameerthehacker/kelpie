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
 * it. Read from the scroll position on every scroll, so a jump straight from below the view to
 * stuck (jump to latest in a short window) is seen too.
 */
export function useStuck(el: Element | null): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const scroller = el?.isConnected ? scrollerOf(el) : null;
    if (!el || !scroller) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      setStuck(scroller.scrollTop > 0 && el.getBoundingClientRect().top - scroller.getBoundingClientRect().top < 0.5);
    };
    const onScroll = () => {
      frame ||= requestAnimationFrame(check);
    };
    check();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [el]);
  return stuck;
}

/**
 * Whether `el` has scrolled up out of its scroller's view, entirely above its top edge. False for
 * an element no longer on the page (the last tab's title, for a render), and until a new one is seen.
 */
export function useScrolledPast(el: Element | null): boolean {
  const [seen, setSeen] = useState<{ el: Element; past: boolean } | undefined>();
  useEffect(() => {
    if (!el?.isConnected) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // A batch can hold more than one entry for it (the first look, then a jump): the last is now.
        const entry = entries.at(-1);
        if (!entry?.rootBounds) return;
        setSeen({ el, past: !entry.isIntersecting && entry.boundingClientRect.bottom <= entry.rootBounds.top });
      },
      { root: scrollerOf(el), threshold: [0] },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return !!seen && seen.el === el && seen.past;
}
