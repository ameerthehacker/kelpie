import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useReducedMotion } from 'motion/react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { Conversation } from '@/components/ai-elements/conversation';

/**
 * Where the person left a chat they had scrolled up in: the entry at the top of the view and how
 * far into it. Not a scroll offset: the chat may come back wider or narrower (the agent pane was
 * open, say), and everything above would have reflowed.
 */
interface Spot {
  index: number;
  /** How far down the entry the view's top edge was, as a fraction of its height. */
  into: number;
}

/** Where the person left each chat they had scrolled up in, for this page load. */
const positions = new Map<string, Spot>();

function spotOf(scroller: HTMLElement, content: HTMLElement): Spot | undefined {
  const top = scroller.getBoundingClientRect().top;
  const entries = content.children;
  for (let index = 0; index < entries.length; index++) {
    const r = entries[index]!.getBoundingClientRect();
    if (r.bottom > top) return { index, into: r.height ? (top - r.top) / r.height : 0 };
  }
}

/** The scroll offset that puts `spot` back at the top, or as far down as the chat goes while it isn't loaded yet. */
function scrollTopOf(spot: Spot, scroller: HTMLElement, content: HTMLElement): number {
  const entry = content.children[spot.index];
  if (!entry) return scroller.scrollHeight;
  const r = entry.getBoundingClientRect();
  return scroller.scrollTop + r.top - scroller.getBoundingClientRect().top + spot.into * r.height;
}

const QUIET_MS = 300; // the log's replay has gone this long without growing
const LOAD_MAX_MS = 2000;
const NEAR_BOTTOM_PX = 70; // as use-stick-to-bottom counts it

/**
 * A round-up's chat, kept at the bottom as it grows. Opening one shows its latest messages at
 * once, or where the person left it if they had scrolled up: while its log replays, each render
 * is pinned there before paint. Only content arriving after that slides in, and never with
 * reduced motion. Remount it (key it) per round-up.
 */
export function ChatLog({ id, content, className, children }: { id: string | undefined; content: unknown; className?: string; children: ReactNode }) {
  const reduced = useReducedMotion();
  const [loaded, setLoaded] = useState(false);
  const smooth = loaded && !reduced;
  const instance = useStickToBottom({ initial: 'instant', resize: smooth ? 'smooth' : 'instant' });
  const { scrollRef, contentRef, state, stopScroll } = instance;
  const saved = useRef(id ? positions.get(id) : undefined);

  // While loading, every render lands where it should before it is painted (the library's own
  // follow waits a frame). Through its setter, so it isn't taken for the person scrolling.
  useLayoutEffect(() => {
    if (loaded) return;
    const el = scrollRef.current;
    const inner = contentRef.current;
    if (!el || !inner) return;
    if (saved.current !== undefined) {
      // Unlocked every time: the log starts over empty, and a chat too short to scroll locks again.
      if (state.isAtBottom) stopScroll();
      state.scrollTop = scrollTopOf(saved.current, el, inner);
    } else if (state.isAtBottom) state.scrollTop = el.scrollHeight;
  }, [content, loaded, scrollRef, contentRef, state, stopScroll]);

  // Loaded once the replay goes quiet, after a while regardless, or as soon as the person takes over.
  useEffect(() => {
    if (loaded) return;
    const timer = setTimeout(() => setLoaded(true), QUIET_MS);
    return () => clearTimeout(timer);
  }, [content, loaded]);
  useEffect(() => {
    const el = scrollRef.current;
    const done = () => setLoaded(true);
    const timer = setTimeout(done, LOAD_MAX_MS);
    const input = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    for (const e of input) el?.addEventListener(e, done, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const e of input) el?.removeEventListener(e, done);
    };
  }, [scrollRef]);

  // Remember the spot once loaded (until then the one from last time still holds).
  useEffect(() => {
    const el = scrollRef.current;
    const inner = contentRef.current;
    if (!loaded || !id || !el || !inner) return;
    const record = () => {
      const spot = el.scrollHeight - el.scrollTop - el.clientHeight > NEAR_BOTTOM_PX && spotOf(el, inner);
      if (spot) positions.set(id, spot);
      else positions.delete(id);
    };
    record();
    el.addEventListener('scroll', record, { passive: true });
    return () => el.removeEventListener('scroll', record);
  }, [loaded, id, scrollRef, contentRef]);

  return (
    <Conversation instance={instance} className={className}>
      {children}
    </Conversation>
  );
}
