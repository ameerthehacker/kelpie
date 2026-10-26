import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useReview } from '@/hooks/use-review';
import { canSubmit, reviewCounts, VERDICT_LABEL, type Verdict } from '@/lib/review';
import { cn } from '@/lib/utils';
import { pill, primaryButton } from './thread';

const VERDICTS: Verdict[] = ['comment', 'request_changes', 'approve'];

/** One way to finish the review: a summary, then submit (every pending comment goes with it). */
function SubmitPopover({ verdict, roundUpId, pending }: { verdict: Verdict; roundUpId: string; pending: number }) {
  const review = useReview(roundUpId);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const run = async (what: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await what();
      setBody('');
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ok = canSubmit(verdict, pending, body);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn(pill, 'h-[34px] px-3.5', verdict === 'approve' ? 'bg-fg text-background' : 'bg-background text-fg border-ln2 hover:bg-hov border')}>
          {VERDICT_LABEL[verdict]}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-3 rounded-2xl p-3.5">
        <div className="text-sm font-medium">{VERDICT_LABEL[verdict]}</div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          maxLength={10_000}
          aria-label="Summary"
          placeholder={verdict === 'approve' ? 'Leave a note (optional)' : 'Leave a summary (optional)'}
          className="bg-chip text-fg placeholder:text-ph w-full resize-y rounded-xl px-3 py-2 text-sm outline-none"
        />
        {!ok && <p className="text-mu text-xs">Add a comment on a line, or a summary, first.</p>}
        {error && <p className="text-fail text-xs">{error}</p>}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={busy || pending === 0}
            onClick={() => run(() => review.discard())}
            className={cn(pill, 'text-mu hover:text-fail px-2')}
          >
            Discard draft
          </button>
          <button type="button" disabled={busy || !ok} onClick={() => run(() => review.submit({ verdict, body }))} className={primaryButton}>
            Submit review ({pending} comment{pending === 1 ? '' : 's'})
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** "Click any line to comment", where the review stands, and the three ways to submit it. */
export function ReviewBar({ roundUpId, compact, className }: { roundUpId: string; compact?: boolean; className?: string }) {
  const { state } = useReview(roundUpId);
  const counts = reviewCounts(state?.threads ?? []);
  return (
    <div className={cn('bg-well flex flex-wrap items-center gap-3 rounded-2xl py-2.5 pr-2.5 pl-4', className)}>
      <p className={cn('text-fg2 min-w-0 flex-1 text-[13px] leading-[1.45]', compact && 'max-lg:hidden')}>
        {!compact && 'Click any line to comment · '}
        {counts.open} open, {counts.resolved} resolved
        {counts.pending > 0 && (
          <span className="text-wait">
            {' '}
            · {counts.pending} pending comment{counts.pending === 1 ? '' : 's'}
          </span>
        )}
      </p>
      <div className="flex shrink-0 items-center gap-1.5">
        {VERDICTS.map((v) => (
          <SubmitPopover key={v} verdict={v} roundUpId={roundUpId} pending={counts.pending} />
        ))}
      </div>
    </div>
  );
}
