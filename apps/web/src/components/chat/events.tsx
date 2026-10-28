import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type EventTone = 'done' | 'fail' | 'muted';

const DOT: Record<EventTone, string> = { done: 'bg-done', fail: 'bg-fail', muted: 'bg-mu2' };

/** The design's one-line event: a small dot, then what happened. A button when it leads somewhere. */
export function EventLine({ tone, children, onClick, title }: { tone: EventTone; children: ReactNode; onClick?: () => void; title?: string }) {
  const body = (
    <>
      <span aria-hidden="true" className={cn('mt-2 size-1.5 shrink-0 rounded-full', DOT[tone])} />
      <span className="min-w-0">{children}</span>
    </>
  );
  const cls = 'text-mu2 flex items-start gap-2.5 text-left text-[13px]';
  return onClick ? (
    <button type="button" onClick={onClick} title={title} className={cn(cls, 'hover:text-fg')}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}
