import { ClaudeLogo } from '@/components/claude-logo';
import { harnessOf } from '@/lib/harnesses';
import { cn } from '@/lib/utils';

// Badge tints from the design canvas (Codex teal), with light-mode pairs.
const TINT: Record<string, string> = {
  codex: 'bg-cxb text-cxf',
};

/** A harness at a glance: Claude's logo for Claude Code, a tinted two-letter mark for others. */
export function HarnessMark({ harness, size = 'sm', className }: { harness: string; size?: 'sm' | 'lg'; className?: string }) {
  const h = harnessOf(harness);
  const box = size === 'sm' ? 'size-[18px]' : 'size-7';
  if (harness === 'claude-code') return <ClaudeLogo label={h.name} className={cn(box, size === 'sm' ? 'p-px' : 'p-0.5', className)} />;
  return (
    <span
      role="img"
      aria-label={h.name}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-mono font-semibold tracking-tight',
        box,
        size === 'sm' ? 'rounded-md text-[9px]' : 'rounded-[9px] text-[11px]',
        TINT[harness] ?? 'border',
        className,
      )}
    >
      {h.mark}
    </span>
  );
}
