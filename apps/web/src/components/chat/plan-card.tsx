import { ClipboardListIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { MessageResponse } from '@/components/ai-elements/message';
import { useAnswerApprovals } from '@/hooks/use-approvals';
import type { PlanView } from '@/lib/chat';
import { MODE_INFO } from '@/lib/modes';
import { cn } from '@/lib/utils';

const STATE: Record<PlanView['state'], string> = {
  open: 'Waiting for you',
  approved: 'Approved',
  declined: 'Sent back',
  expired: 'No longer waiting',
};

const btn = 'h-8 rounded-full px-3.5 text-[13px] font-medium disabled:opacity-50';

/**
 * The orchestrator's plan, put to the person in plan mode. Approving it takes the round-up out of
 * plan mode (into Auto or Accept edits) and the orchestrator carries it out; sending it back with a
 * note keeps planning.
 */
export function PlanCard({ plan, sessionId }: { plan: PlanView; sessionId: string | undefined }) {
  const answer = useAnswerApprovals();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const open = plan.state === 'open' && !!sessionId;

  const send = async (a: { decision: 'allow'; mode: 'auto' | 'acceptEdits' } | { decision: 'deny'; message: string }) => {
    if (!sessionId) return;
    setBusy(true);
    setError(undefined);
    try {
      const { missed } = await answer({ items: [{ sessionId, requestId: plan.requestId }], ...a });
      if (missed) setError('The plan is no longer waiting: its run ended.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const keepPlanning = (e: FormEvent) => {
    e.preventDefault();
    if (note.trim()) void send({ decision: 'deny', message: note.trim() });
  };

  return (
    <section aria-label="Plan" className={cn('bg-surf border-ln flex flex-col gap-3 rounded-2xl border p-4', open && 'border-vio/50')}>
      <header className="flex items-center gap-2 text-sm">
        <ClipboardListIcon className="text-vio size-4" strokeWidth={2} />
        <span className="font-medium">Plan</span>
        <span className="text-mu text-xs">· {STATE[plan.state]}</span>
      </header>
      {plan.plan ? (
        <div className="max-h-96 overflow-y-auto text-sm">
          <MessageResponse>{plan.plan}</MessageResponse>
        </div>
      ) : (
        <p className="text-mu text-sm">The plan is in the message above.</p>
      )}
      {plan.message && <p className="text-mu text-sm">Your note: {plan.message}</p>}
      {open && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            <button type="button" disabled={busy} onClick={() => void send({ decision: 'allow', mode: 'auto' })} className={cn(btn, 'bg-acc text-accfg')}>
              Approve · {MODE_INFO.auto.label}
            </button>
            <button type="button" disabled={busy} onClick={() => void send({ decision: 'allow', mode: 'acceptEdits' })} className={cn(btn, 'bg-chip text-fg2 hover:bg-raise')}>
              Approve · {MODE_INFO.acceptEdits.label}
            </button>
          </div>
          <form onSubmit={keepPlanning} className="flex items-center gap-1.5">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Or say what to change, and keep planning"
              className="bg-chip text-fg h-8 min-w-0 flex-1 rounded-full px-3.5 text-[13px] outline-none"
            />
            <button type="submit" disabled={busy || !note.trim()} className={cn(btn, 'bg-chip text-fg2 hover:bg-raise')}>
              Keep planning
            </button>
          </form>
          {error && <p className="text-fail text-xs">{error}</p>}
        </div>
      )}
    </section>
  );
}
