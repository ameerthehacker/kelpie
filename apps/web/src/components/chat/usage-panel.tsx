import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useUsage } from '@/hooks/use-usage';
import { HARNESSES, metersOf } from '@/lib/usage';
import { cn } from '@/lib/utils';

// Harness badge tints from the design canvas (Claude Code clay, Codex teal), with light-mode pairs.
const TINT: Record<string, string> = {
  'claude-code': 'bg-[#F7E3D8] text-[#8F4220] dark:bg-[#3A2A22] dark:text-[#F2A884]',
  codex: 'bg-[#DDF0F4] text-[#1D5F6E] dark:bg-[#1D2F35] dark:text-[#86D3E3]',
};

export function HarnessMark({ harness, className }: { harness: string; className?: string }) {
  const h = HARNESSES[harness];
  return (
    <span
      role="img"
      aria-label={h?.name ?? harness}
      className={cn(
        'inline-flex size-[18px] flex-none items-center justify-center rounded-[5px] font-mono text-[9px] font-semibold tracking-tight',
        TINT[harness] ?? 'border',
        className,
      )}
    >
      {h?.mark ?? harness.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** The sidebar's "Usage" section: each harness's subscription windows, as last reported. */
export function UsagePanel({ now }: { now: number }) {
  const { data: usage, isPending, isError } = useUsage();

  return (
    <section aria-label="Usage limits" className="flex flex-col gap-3.5 border-t px-2.5 pt-3.5">
      <div className="text-muted-foreground text-xs">Usage</div>
      {isPending && <Skeleton className="h-16 w-full" />}
      {isError && <p className="text-muted-foreground text-xs">Couldn’t load usage from the daemon.</p>}
      {usage?.length === 0 && <p className="text-muted-foreground text-xs">Shows up after Claude Code’s first turn.</p>}
      {usage?.map((u) => {
        const name = HARNESSES[u.harness]?.name ?? u.harness;
        return (
          <div key={u.harness} className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[13px]">
              <HarnessMark harness={u.harness} />
              {name}
            </div>
            {metersOf(u, now).map((m) => (
              <div key={m.label} className="flex flex-col gap-1">
                <div className="flex items-baseline gap-1.5 text-xs">
                  <span className="text-sidebar-foreground/85">{m.label}</span>
                  <span className={cn('ml-auto font-mono', m.warn ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>{m.pct}%</span>
                </div>
                <Progress
                  value={m.pct}
                  aria-label={`${name} ${m.label.toLowerCase()}`}
                  className={cn(
                    'bg-sidebar-accent',
                    m.warn ? '[&>[data-slot=progress-indicator]]:bg-amber-500' : '[&>[data-slot=progress-indicator]]:bg-sidebar-foreground/70',
                  )}
                />
                <div className="text-muted-foreground text-[11px]">{m.reset}</div>
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}
