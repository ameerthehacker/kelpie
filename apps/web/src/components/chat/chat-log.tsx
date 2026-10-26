import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useReducedMotion } from 'motion/react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { Conversation } from '@/components/ai-elements/conversation';
import { belowView, scrollTopFor, spotAt, type Spot } from '@/lib/scroll-spot';

/** Where the person left each chat they had scrolled up in, for this page load. */
const positions = new Map<string, Spot>();

/**
 * The chat's head: how many entries lead it (`data-chat-head`: the title, the tabs), and the
 * height of the one stuck to the top that the rest scroll under. Spots count past the head, from
 * its sticky bar's bottom edge: stuck, its box would read as the entry at the top.
 */
function headOf(content: HTMLElement): { skip: number; cover: number } {
  let skip = 0;
  let cover = 0;
  for (const el of content.children) {
    if (!(el instanceof HTMLElement) || el.dataset.chatHead === undefined) break;
    skip++;
    if (el.dataset.chatHead === 'sticky') cover = el.offsetHeight;
  }
  return { skip, cover };
}

function spotOf(scroller: HTMLElement, content: HTMLElement): Spot | undefined {
  const entries = content.children;
  const { skip, cover } = headOf(content);
  return spotAt(scroller.getBoundingClientRect().top + cover, entries.length - skip, (i) => entries[skip + i]!.getBoundingClientRect());
}

/** The scroll offset that puts `spot` back at the top, or as far down as the chat goes while it isn't loaded yet. */
function scrollTopOf(spot: Spot, scroller: HTMLElement, content: HTMLElement): number {
  const { skip, cover } = headOf(content);
  const entry = content.children[skip + spot.index]?.getBoundingClientRect();
  return scrollTopFor(spot, entry, { scrollTop: scroller.scrollTop, top: scroller.getBoundingClientRect().top + cover, scrollHeight: scroller.scrollHeight });
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
export function ChatLog({ id, content, className, children }: { id: string | undefined; content: readonly unknown[]; className?: string; children: ReactNode }) {
  const reduced = useReducedMotion();
  const [loaded, setLoaded] = useState(false);
  const smooth = loaded && !reduced;
  const instance = useStickToBottom({ initial: 'instant', resize: smooth ? 'smooth' : 'instant' });
  const { scrollRef, contentRef, state, stopScroll, scrollToBottom } = instance;
  const saved = useRef(id ? positions.get(id) : undefined);
  const byPerson = useRef(false);
  // The log starts over empty (and may first show the last round-up's for a render): nothing has
  // been replayed until something is there, however long the first batch takes.
  const filled = content.length > 0;

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

  // Loaded once the replay goes quiet, or after a while regardless, counted from its first batch.
  useEffect(() => {
    if (loaded || !filled) return;
    const timer = setTimeout(() => setLoaded(true), QUIET_MS);
    return () => clearTimeout(timer);
  }, [content, filled, loaded]);
  useEffect(() => {
    if (loaded || !filled) return;
    const timer = setTimeout(() => setLoaded(true), LOAD_MAX_MS);
    return () => clearTimeout(timer);
  }, [filled, loaded]);
  // Or as soon as the person takes over, anywhere in the chat (its jump-to-latest button too).
  const takeOver = loaded
    ? undefined
    : () => {
        byPerson.current = true;
        setLoaded(true);
      };

  // Loaded on its own at the bottom (the spot left from last time is gone, or hasn't come yet):
  // follow new messages from here, as if it had opened at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!loaded || byPerson.current || !el || state.isAtBottom) return;
    if (belowView(el) <= NEAR_BOTTOM_PX) void scrollToBottom('instant');
  }, [loaded, scrollRef, state, scrollToBottom]);

  // Remember the spot once loaded (until then the one from last time still holds).
  useEffect(() => {
    const el = scrollRef.current;
    const inner = contentRef.current;
    if (!loaded || !filled || !id || !el || !inner) return;
    let frame = 0;
    const record = () => {
      frame = 0;
      const spot = belowView(el) > NEAR_BOTTOM_PX && spotOf(el, inner);
      if (spot) positions.set(id, spot);
      else positions.delete(id);
    };
    const onScroll = () => {
      frame ||= requestAnimationFrame(record);
    };
    record();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [loaded, filled, id, scrollRef, contentRef]);

  return (
    <Conversation
      instance={instance}
      className={className}
      onWheelCapture={takeOver}
      onTouchStartCapture={takeOver}
      onPointerDownCapture={takeOver}
      onKeyDownCapture={takeOver}
    >
      {children}
    </Conversation>
  );
}
