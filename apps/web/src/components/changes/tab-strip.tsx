import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Underlined tabs, each with an optional count: the round-up's Conversation | Changes, an agent's Activity | Changes. */
export function TabStrip<T extends string>({
  label,
  tabs,
  value,
  onChange,
  className,
  children,
}: {
  label: string;
  tabs: { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  /** Anything to the right of the tabs. */
  children?: ReactNode;
}) {
  return (
    <div className={cn('border-ln flex items-center gap-5 border-b', className)}>
      <div role="tablist" aria-label={label} className="flex items-center gap-5">
        {tabs.map((t) => {
          const on = t.id === value;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onChange(t.id)}
              className={cn('-mb-px flex h-9 items-center gap-1.5 border-b-2 text-[13px]', on ? 'border-fg text-fg font-medium' : 'text-mu hover:text-fg border-transparent')}
            >
              {t.label}
              {t.count !== undefined && <span className="bg-chip text-mu rounded-full px-1.5 font-mono text-[10.5px] leading-[18px]">{t.count}</span>}
            </button>
          );
        })}
      </div>
      <span className="flex-1" />
      {children}
    </div>
  );
}
