import { ChevronDownIcon, ShieldAlertIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useAnswerApprovals, useForgetRule, useRules, type Answer } from '@/hooks/use-approvals';
import { approvalsSummary, groupApprovals, pendingQuestions, type ApprovalGroup, type PendingApproval } from '@/lib/approvals';
import { cn } from '@/lib/utils';
import { ApprovalRow, type GroupAnswer } from './approval-row';
import { QuestionRow } from './question-row';

const btn = 'h-7 shrink-0 rounded-full px-3 text-xs font-medium disabled:opacity-50';

/** Answers groups of requests, keeping track of what is in flight and what went wrong. */
export function useGroupAnswers() {
  const answer = useAnswerApprovals();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const run = async (groups: ApprovalGroup[], a: GroupAnswer) => {
    const body: Answer = {
      items: groups.flatMap((g) => g.items.map(({ sessionId, requestId }) => ({ sessionId, requestId }))),
      ...a,
    };
    setBusy(true);
    setError(undefined);
    try {
      await answer(body);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error };
}

/**
 * What a round-up's agents are waiting on the person for, docked above the composer. Requests for
 * the same thing are one row, however many agents ask; questions queue after them, oldest first,
 * each answered on its own. Keys, with the request rows focused: j/k to move, a to allow, r to allow
 * for the round-up, d to deny. `inChat`: the session whose chat is on screen, its questions shown there.
 * `openFirst`: open the oldest question's card (where there is room for it, as on the approvals page).
 */
export function ApprovalTray({ approvals, roundUpId, inChat, openFirst = false }: { approvals: PendingApproval[]; roundUpId: string; inChat?: string | undefined; openFirst?: boolean }) {
  const groups = useMemo(() => groupApprovals(approvals), [approvals]);
  const questions = useMemo(() => pendingQuestions(approvals).filter((q) => q.sessionId !== inChat), [approvals, inChat]);
  const rules = useRules(groups.length ? roundUpId : undefined);
  const forget = useForgetRule(roundUpId);
  const { run, busy, error } = useGroupAnswers();
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState(0);
  // Rows leave as they are answered (here or anywhere): keep the selection on a row.
  useEffect(() => setSelected((i) => Math.min(i, Math.max(0, groups.length - 1))), [groups.length]);
  if (!groups.length && !questions.length) return null;
  const shown = approvals.filter((a) => groups.some((g) => g.items.includes(a)) || questions.includes(a));

  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    const g = groups[selected];
    const act: Record<string, () => void> = {
      j: () => setSelected((i) => Math.min(groups.length - 1, i + 1)),
      ArrowDown: () => setSelected((i) => Math.min(groups.length - 1, i + 1)),
      k: () => setSelected((i) => Math.max(0, i - 1)),
      ArrowUp: () => setSelected((i) => Math.max(0, i - 1)),
      a: () => g && void run([g], { decision: 'allow' }),
      r: () => g?.rule && void run([g], { decision: 'allow', remember: true }),
      d: () => g && void run([g], { decision: 'deny' }),
    };
    const f = act[e.key];
    if (f) {
      e.preventDefault();
      f();
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="bg-surf border-wait/50 mb-2 rounded-[20px] border text-sm">
      <div className="flex items-center gap-2 py-1.5 pr-2 pl-4">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2.5 py-1 text-left">
          <ShieldAlertIcon className="text-wait size-4 shrink-0" strokeWidth={2} />
          <span className="font-medium">Waiting on you</span>
          <span className="text-mu truncate text-xs">{approvalsSummary(shown)}</span>
          <ChevronDownIcon className={cn('text-mu2 size-4 shrink-0 transition-transform', !open && '-rotate-90')} />
        </CollapsibleTrigger>
        {groups.length > 1 && (
          <>
            <button type="button" disabled={busy} onClick={() => run(groups, { decision: 'allow' })} className={cn(btn, 'bg-chip text-fg2 hover:bg-raise')}>
              Allow all
            </button>
            <button type="button" disabled={busy} onClick={() => run(groups, { decision: 'deny' })} className={cn(btn, 'bg-chip text-fail hover:bg-raise')}>
              Deny all
            </button>
          </>
        )}
      </div>
      <CollapsibleContent>
        <div className="border-ln max-h-[min(28rem,50vh)] overflow-y-auto border-t px-1.5 py-1.5">
          {groups.length > 0 && (
            <ul tabIndex={0} onKeyDown={onKey} className="flex flex-col gap-0.5 rounded-xl outline-none" aria-label="Approvals (j/k to move, a allow, r allow for round-up, d deny)">
              {groups.map((g, i) => (
                <ApprovalRow key={g.key} group={g} selected={i === selected} busy={busy} onSelect={() => setSelected(i)} onAnswer={(a) => void run([g], a)} />
              ))}
            </ul>
          )}
          {questions.length > 0 && (
            <ul aria-label="Questions" className="flex flex-col gap-0.5">
              {questions.map((q, i) => (
                <QuestionRow key={`${q.sessionId}:${q.requestId}`} item={q} defaultOpen={openFirst && i === 0} />
              ))}
            </ul>
          )}
          {error && <p className="text-fail px-2.5 pt-1.5 text-xs">{error}</p>}
          {rules.length > 0 && (
            <div className="text-mu flex flex-wrap items-center gap-1.5 px-2.5 pt-2 pb-1 text-xs">
              Allowed for this round-up:
              {rules.map((r) => (
                <span key={r.id} className="bg-chip text-fg2 flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2 font-mono text-[11px]">
                  {r.rule}
                  <button type="button" onClick={() => void forget(r.id)} aria-label={`Stop allowing ${r.rule}`} className="hover:text-fg rounded-full p-0.5">
                    <XIcon className="size-3" strokeWidth={2.2} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
