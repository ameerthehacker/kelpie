import { ChevronDownIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useAgents } from '@/hooks/use-agents';
import { useAnswerApprovals, useForgetRule, useRules, type Answer } from '@/hooks/use-approvals';
import { approvalsSummary, focusAfter, groupApprovals, pendingQuestions, questionKey, shownQuestion, type ApprovalGroup, type PendingApproval } from '@/lib/approvals';
import { cn } from '@/lib/utils';
import { ApprovalRow, type GroupAnswer } from './approval-row';
import { QuestionItem } from './question-item';

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
 * What a round-up's agents are waiting on the person for: one panel with one header, docked above
 * the composer. Requests for the same thing are one compact row, however many agents ask; below
 * them, the oldest question is open to answer, the rest a ‹ › away. Keys, with the request rows
 * focused: j/k to move, a to allow, r to allow for the round-up, d to deny. `inChat`: the session
 * whose chat is on screen, its questions shown there. `docked`: above the composer, the chat
 * fading out behind it. `fit`: as tall as it needs, where the page around it scrolls (one scroll,
 * not two).
 */
export function ApprovalTray({ approvals, roundUpId, inChat, docked = false, fit = false }: {
  approvals: PendingApproval[];
  roundUpId: string;
  inChat?: string | undefined;
  docked?: boolean;
  fit?: boolean;
}) {
  const groups = useMemo(() => groupApprovals(approvals), [approvals]);
  const questions = useMemo(() => pendingQuestions(approvals).filter((q) => q.sessionId !== inChat), [approvals, inChat]);
  const agents = useAgents(questions.length ? roundUpId : undefined);
  const rules = useRules(groups.length ? roundUpId : undefined);
  const forget = useForgetRule(roundUpId);
  const { run, busy, error } = useGroupAnswers();
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState(0);
  /** The question the person paged to; once it is answered, the oldest left shows. */
  const [picked, setPicked] = useState<string | undefined>();
  /** The question to take the keyboard as it shows, once: the person paged to it, or answered the one before. */
  const [focusQ, setFocusQ] = useState<string | undefined>();
  /** The question that has the keyboard, if one does: when it leaves, the keyboard goes on to what is next. */
  const focused = useRef<string | undefined>(undefined);
  const waiting = useRef<string[]>([]);
  const approvalsList = useRef<HTMLUListElement>(null);
  const qi = shownQuestion(questions, picked);
  const question = questions[qi];
  // Rows leave as they are answered (here or anywhere): keep the selection on a row.
  useEffect(() => setSelected((i) => Math.min(i, Math.max(0, groups.length - 1))), [groups.length]);
  // The question with the keyboard went (its card with it, the keyboard left on the page): hand it on.
  useEffect(() => {
    waiting.current = questions.map(questionKey);
    const to = focusAfter(questions, focused.current, qi, groups.length);
    if (!to) return;
    focused.current = undefined;
    if (to === 'approvals') approvalsList.current?.focus();
    else if (to !== 'none') setFocusQ(to.question);
  }, [questions, qi, groups.length]);
  // Only as it shows: never again on its own (the tray reopening, the question coming back).
  useEffect(() => {
    if (focusQ) setFocusQ(undefined);
  }, [focusQ]);
  if (!groups.length && !questions.length) return null;
  const shown = approvals.filter((a) => groups.some((g) => g.items.includes(a)) || questions.includes(a));
  const asks = groups.reduce((n, g) => n + g.items.length, 0);
  /** Whether the keyboard left the questions, or the question it was on went (then it is handed on). */
  const onBlur = (e: FocusEvent<HTMLElement>, key: string) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    // Nowhere in particular: a click on the page, or the card going as it is answered. Tell them apart once the queue has caught up.
    if (e.relatedTarget) focused.current = undefined;
    else
      setTimeout(() => {
        if (focused.current === key && waiting.current.includes(key)) focused.current = undefined;
      });
  };
  const harness = (q: PendingApproval) => (q.sessionId === q.roundUpId ? 'claude-code' : agents?.find((a) => a.id === q.sessionId)?.harness);

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
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        'bg-surf border-ln shadow-card relative mb-2 flex flex-col rounded-[20px] border text-sm',
        // A phone has less chat to keep in view, and needs the room: its rows wrap.
        !fit && 'max-h-[min(36rem,55dvh)] max-sm:max-h-[62dvh]',
        // The chat ends above the tray: fade it out there rather than cut it off.
        docked && 'before:from-background before:pointer-events-none before:absolute before:inset-x-0 before:-top-7 before:h-6 before:bg-linear-to-t before:to-transparent',
      )}
    >
      <div className="flex shrink-0 items-center gap-2 py-1.5 pr-2 pl-4">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left">
          <span aria-hidden="true" className="bg-wait size-2 shrink-0 rounded-full" />
          <span className="shrink-0 font-medium whitespace-nowrap">Waiting on you</span>
          <span className="text-mu truncate text-xs">· {approvalsSummary(shown)}</span>
          <ChevronDownIcon className={cn('text-mu2 size-4 shrink-0 transition-transform', !open && '-rotate-90')} />
        </CollapsibleTrigger>
        {groups.length > 1 && (
          <>
            {/* The approvals only: questions are answered one by one. */}
            <button type="button" disabled={busy} onClick={() => run(groups, { decision: 'allow' })} className={cn(btn, 'bg-chip text-fg2 hover:bg-raise')}>
              Allow {asks}
              <span className="max-sm:hidden"> approvals</span>
            </button>
            <button type="button" disabled={busy} onClick={() => run(groups, { decision: 'deny' })} className={cn(btn, 'bg-chip text-fail hover:bg-raise')}>
              Deny {asks}
              <span className="max-sm:hidden"> approvals</span>
            </button>
          </>
        )}
      </div>
      <CollapsibleContent className="border-ln flex min-h-0 flex-1 flex-col border-t">
        {groups.length > 0 && (
          <div
            className={cn(
              'flex flex-col px-1.5 py-1.5',
              // Docked, the question gets the room: the approvals give way to it, down to a row (two lines, wrapped, on a phone).
              !fit && 'overflow-y-auto [scrollbar-color:var(--ln2)_transparent] [scrollbar-width:thin]',
              !fit && (question ? 'max-h-[9.5rem] min-h-[3.75rem] max-sm:min-h-[6.75rem]' : 'min-h-0 flex-1'),
            )}
          >
            <ul ref={approvalsList} tabIndex={0} onKeyDown={onKey} className="group/approvals flex flex-col gap-0.5 rounded-xl outline-none" aria-label="Approvals (j/k to move, a allow, r allow for round-up, d deny)">
              {groups.map((g, i) => (
                <ApprovalRow key={g.key} group={g} selected={i === selected} busy={busy} onSelect={() => setSelected(i)} onAnswer={(a) => void run([g], a)} />
              ))}
            </ul>
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
        )}
        {question && (
          <section
            aria-label="Questions"
            onFocus={() => (focused.current = questionKey(question))}
            onBlur={(e) => onBlur(e, questionKey(question))}
            // Never squeezed out by the approvals: room for its tabs, a few options and its buttons.
            className={cn('flex flex-col', !fit && (groups.length > 0 ? 'min-h-[13rem] flex-1' : 'min-h-0 flex-1'), groups.length > 0 && 'border-ln border-t')}
          >
            <QuestionItem
              item={question}
              harness={harness(question)}
              index={qi}
              count={questions.length}
              onMove={(to) => {
                const key = questions[to] && questionKey(questions[to]);
                setPicked(key);
                setFocusQ(key);
              }}
              takeFocus={focusQ === questionKey(question)}
              scroll={!fit}
            />
          </section>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
