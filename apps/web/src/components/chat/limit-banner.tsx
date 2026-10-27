import { format } from 'date-fns';
import { MoonIcon, PlayIcon, SquareIcon, SunriseIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLimitActions } from '@/hooks/use-limit';
import { useNow } from '@/hooks/use-now';
import { limitLine, pausedLabel, RESUMED_LINE, type TurnLimit, type UsageLimitPause } from '@/lib/limits';
import { cn } from '@/lib/utils';

/**
 * A session paused at the usage limit, above its composer or in the agent pane: when Kelpie picks
 * it up again, with "Resume now" and "Don't auto-resume". Calm: nothing is wrong, it is waiting.
 */
export function PausedBanner({ sessionId, pause, className }: { sessionId: string; pause: UsageLimitPause; className?: string }) {
  const now = useNow(30_000);
  const { resumeNow, cancel, pending, error } = useLimitActions(sessionId);
  return (
    // Not a live region: the countdown in it changes every half minute.
    <div className={cn('bg-surf border-ln flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[20px] border px-4 py-2.5 text-sm', className)}>
      <MoonIcon aria-hidden="true" className="text-run size-4 shrink-0" strokeWidth={1.9} />
      <span className="min-w-0 flex-1">
        {pausedLabel(pause, now)}
        {error && <span className="text-fail block text-xs">{error}</span>}
      </span>
      <span className="flex shrink-0 gap-1.5">
        {pause.retryAt && (
          <Button variant="ghost" size="sm" disabled={pending} onClick={cancel} title="Keep it paused until you send it something">
            Don’t auto-resume
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={pending} onClick={resumeNow} title="Try now: if the limit has lifted, the rest of the paused work follows">
          Resume now
        </Button>
      </span>
    </div>
  );
}

/** A turn that stopped at the usage limit: calm, not a failure, with when Kelpie picks it up (the harness's words on hover). */
export function LimitLine({ limit, message, ts }: { limit: TurnLimit; message: string; ts: string }) {
  const now = useNow();
  return (
    <p title={message || undefined} className="text-mu2 flex items-start gap-2.5 text-[13px]">
      <MoonIcon aria-hidden="true" className="text-run mt-[3px] size-3.5 shrink-0" strokeWidth={2} />
      <span className="min-w-0">
        {limitLine(limit, now)} · {format(new Date(ts), 'HH:mm')}
      </span>
    </p>
  );
}

/** Kelpie picked the work up again once the usage limit reset. */
export function ResumedLine({ ts }: { ts: string }) {
  return (
    <p className="text-mu2 flex items-center gap-2.5 text-[13px]">
      <SunriseIcon aria-hidden="true" className="text-run size-3.5 shrink-0" strokeWidth={2} />
      {RESUMED_LINE} · {format(new Date(ts), 'HH:mm')}
    </p>
  );
}

/** The person stopped every agent of the round-up ("Stop all"), or resumed them. */
export function HaltLine({ action, text, ts }: { action: 'stopped' | 'resumed'; text: string; ts: string }) {
  const Icon = action === 'stopped' ? SquareIcon : PlayIcon;
  return (
    <p className="text-mu2 flex items-center gap-2.5 text-[13px]">
      <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', action === 'stopped' ? 'fill-mu2' : 'text-run fill-run/30')} strokeWidth={2} />
      {text} · {format(new Date(ts), 'HH:mm')}
    </p>
  );
}
