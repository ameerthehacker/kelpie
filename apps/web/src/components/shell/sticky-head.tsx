import { useState, type ReactNode } from 'react';
import { useScrolledPast, useStuck } from '@/hooks/use-scrolled';
import { cn } from '@/lib/utils';

/**
 * A bar pinned to the top of the page's scroller, across its whole column (padding too), with
 * content scrolling under it: shadowed once it does. The chat skips past it (`data-chat-head`)
 * when it notes where the person left off.
 */
export function StickyHead({ className, children }: { className?: string; children: ReactNode }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const stuck = useStuck(el);
  return (
    <div
      ref={setEl}
      data-chat-head="sticky"
      className={cn(
        'bg-background sticky top-0 z-10 -mx-7 px-7 max-sm:-mx-4 max-sm:px-4 motion-safe:transition-shadow motion-safe:duration-150',
        stuck && 'shadow-[0_10px_16px_-14px_rgb(0_0_0/0.3)] dark:shadow-[0_10px_16px_-12px_rgb(0_0_0/0.9)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The page's title, small, for a sticky bar: shown once `titleEl` (the big one) has scrolled away. Always laid out, so nothing moves. */
export function CompactTitle({ title, titleEl }: { title: string; titleEl: Element | null }) {
  const gone = useScrolledPast(titleEl);
  return (
    <span
      aria-hidden={!gone}
      title={gone ? title : undefined}
      className={cn('text-fg2 min-w-0 truncate text-[13px] font-medium motion-safe:transition-opacity motion-safe:duration-150', gone ? 'opacity-100' : 'pointer-events-none opacity-0')}
    >
      {title}
    </span>
  );
}
