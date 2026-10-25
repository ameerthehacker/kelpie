import { ChevronRightIcon, MessageCircleQuestionIcon } from 'lucide-react';
import { useState } from 'react';
import { QuestionCard } from '@/components/chat/question-card';
import { useAnswerApprovals } from '@/hooks/use-approvals';
import type { PendingApproval } from '@/lib/approvals';
import { questionsLine } from '@/lib/questions';
import { cn } from '@/lib/utils';

const btn = 'h-7 shrink-0 rounded-full px-3 text-xs font-medium disabled:opacity-50';

/**
 * Questions one agent is waiting on, in the queue: a line saying what it asks, opening into the
 * same card the agent's chat shows. Each is answered on its own; Skip tells the agent the person
 * would rather not.
 */
export function QuestionRow({ item, defaultOpen }: { item: PendingApproval; defaultOpen: boolean }) {
  const answer = useAnswerApprovals();
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState(false);
  const skip = () => {
    setBusy(true);
    // The stream takes it off the queue; if it was answered elsewhere meanwhile, so much the better.
    answer({ items: [{ sessionId: item.sessionId, requestId: item.requestId }], decision: 'deny' })
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  const questions = item.questions ?? [];
  const who = item.sessionId === item.roundUpId ? 'Kelpie' : item.agentTitle;
  return (
    <li className="flex flex-col gap-1.5 rounded-xl px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? 'Hide the questions' : 'Show the questions'}
          className="text-mu2 hover:text-fg -ml-1 rounded p-0.5"
        >
          <ChevronRightIcon className={cn('size-3.5 transition-transform', open && 'rotate-90')} strokeWidth={2.2} />
        </button>
        <MessageCircleQuestionIcon className="text-wait size-4 shrink-0" strokeWidth={1.9} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-fg truncate text-[13px]" title={questionsLine(questions)}>
            {questionsLine(questions)}
          </span>
          <span className="text-mu truncate text-xs">{who} asks</span>
        </span>
        {!open && (
          <span className="flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={() => setOpen(true)} className={cn(btn, 'bg-acc text-accfg')}>
              Answer
            </button>
            <button type="button" disabled={busy} onClick={skip} className={cn(btn, 'bg-chip text-fg2 hover:bg-raise')}>
              Skip
            </button>
          </span>
        )}
      </div>
      {open && <QuestionCard questions={questions} state="open" sessionId={item.sessionId} requestId={item.requestId} className="ml-7" />}
    </li>
  );
}
