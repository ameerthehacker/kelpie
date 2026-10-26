import { ChevronLeftIcon, ChevronRightIcon, MessageCircleQuestionIcon } from 'lucide-react';
import { QuestionCard } from '@/components/chat/question-card';
import { HarnessMark } from '@/components/harness-mark';
import type { PendingApproval } from '@/lib/approvals';

const nav = 'text-mu2 hover:bg-raise hover:text-fg flex size-6 items-center justify-center rounded-md disabled:pointer-events-none disabled:opacity-40';

/**
 * The question in the queue the person is on: who asks, in a line (with ‹ › to the others queued),
 * then the questions themselves, as the agent's chat shows them (with the same answers picked so far).
 * Each is answered on its own; Skip tells the agent the person would rather not.
 */
export function QuestionItem({ item, harness, index, count, onMove, takeFocus, scroll }: {
  item: PendingApproval;
  /** The asking agent's harness, when known: its mark leads the line. */
  harness: string | undefined;
  index: number;
  count: number;
  onMove: (to: number) => void;
  /** The person moved here, or answered the one before: the questions take the keyboard. */
  takeFocus: boolean;
  /** Whether the questions scroll within the tray (not where the page around it scrolls). */
  scroll: boolean;
}) {
  const questions = item.questions ?? [];
  const who = item.sessionId === item.roundUpId ? 'Kelpie' : item.agentTitle;
  return (
    // All of it is the question card's, as far as Escape goes (‹ › too): it never leaves the page from here.
    <div data-question-card="" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2.5">
        {harness ? <HarnessMark harness={harness} /> : <MessageCircleQuestionIcon className="text-mu2 size-4 shrink-0" strokeWidth={1.9} />}
        <span className="text-mu min-w-0 flex-1 truncate text-xs" title={`${who} asks`}>
          <span className="text-fg2 font-medium">{who}</span> asks
        </span>
        {count > 1 && (
          <span className="text-mu2 flex shrink-0 items-center gap-0.5 text-xs tabular-nums">
            <button type="button" disabled={index === 0} onClick={() => onMove(index - 1)} aria-label="Previous question" className={nav}>
              <ChevronLeftIcon className="size-3.5" strokeWidth={2.2} />
            </button>
            <span aria-live="polite">
              {index + 1} of {count}
            </span>
            <button type="button" disabled={index === count - 1} onClick={() => onMove(index + 1)} aria-label="Next question" className={nav}>
              <ChevronRightIcon className="size-3.5" strokeWidth={2.2} />
            </button>
          </span>
        )}
      </div>
      <QuestionCard
        key={`${item.sessionId}:${item.requestId}`}
        variant="bare"
        questions={questions}
        state="open"
        who={who}
        sessionId={item.sessionId}
        requestId={item.requestId}
        takeFocus={takeFocus}
        scroll={scroll}
        className="min-h-0 flex-1"
      />
    </div>
  );
}
