import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useReducedMotion } from 'motion/react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { Conversation } from '@/components/ai-elements/conversation';

/** Where the person left each chat they had scrolled up in, for this page load. */
const positions = new Map<string, number>();

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
  const { scrollRef, state, stopScroll } = instance;
  const saved = useRef(id ? positions.get(id) : undefined);

  // While loading, every render lands where it should before it is painted (the library's own
  // follow waits a frame). Through its setter, so it isn't taken for the person scrolling.
  useLayoutEffect(() => {
    if (loaded) return;
    const el = scrollRef.current;
    if (!el) return;
    if (saved.current !== undefined) {
      // Unlocked every time: the log starts over empty, and a chat too short to scroll locks again.
      if (state.isAtBottom) stopScroll();
      state.scrollTop = saved.current;
    } else if (state.isAtBottom) state.scrollTop = el.scrollHeight;
  }, [content, loaded, scrollRef, state, stopScroll]);

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
    if (!loaded || !id || !el) return;
    const record = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX) positions.delete(id);
      else positions.set(id, el.scrollTop);
    };
    record();
    el.addEventListener('scroll', record, { passive: true });
    return () => el.removeEventListener('scroll', record);
  }, [loaded, id, scrollRef]);

  return (
    <Conversation instance={instance} className={className}>
      {children}
    </Conversation>
  );
}
