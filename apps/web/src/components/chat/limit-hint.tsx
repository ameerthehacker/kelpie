import { useNow } from '@/hooks/use-now';
import { useUsage } from '@/hooks/use-usage';
import { limitHint } from '@/lib/usage';

/**
 * The composer's warning that a harness is close to, or at, a limit. Its own component so
 * the once-a-minute clock re-renders this line, not the whole conversation.
 */
export function LimitHint({ harness }: { harness: string }) {
  const hint = limitHint(useUsage().data?.find((u) => u.harness === harness), useNow());
  if (!hint) return null;
  return (
    <p className="text-mu flex items-center justify-center gap-2 pt-2.5 text-xs">
      <span aria-hidden="true" className="bg-wait size-[5px] flex-none rotate-45" />
      {hint}
    </p>
  );
}
