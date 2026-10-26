import { CheckIcon, MessageCircleQuestionIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Answers, Question } from '@kelpie/protocol';
import { Kbd } from '@/components/ui/kbd';
import { useAnswerApprovals } from '@/hooks/use-approvals';
import type { QuestionView } from '@/lib/chat';
import { answered, answersOf, chosen, emptyDraft, isPicked, otherIndex, pick, tabLabel, type Draft } from '@/lib/questions';
import { cn } from '@/lib/utils';

const STATE: Record<QuestionView['state'], string> = {
  asking: 'Asking…',
  open: 'Waiting for you',
  answered: 'Answered',
  skipped: 'Skipped',
  refused: 'Not asked',
  expired: 'No longer waiting',
};

const btn = 'h-8 rounded-full px-3.5 text-[13px] font-medium disabled:opacity-50';

export interface QuestionCardProps {
  questions: Question[];
  state: QuestionView['state'];
  /** What was chosen, once answered. */
  answers?: Answers | undefined;
  /** Where to send the answers; without both, the card only shows the questions. */
  sessionId: string | undefined;
  requestId: string | undefined;
  /** Who asks, when it isn't plain from where the card is (the approvals queue). */
  who?: string;
  /** Take the keyboard as it opens, unless something else (the composer) has it. */
  autoFocus?: boolean;
  className?: string;
}

/**
 * Questions an agent puts to the person, as Claude Code's picker has them: each with its options
 * (one to pick, or several), and their own answer under "Other". Several questions are tabs in one
 * card. Keys: ↑/↓ to move, 1–9 or Space to pick, ←/→ between questions, Enter for the next
 * question or to submit. Answered, it folds to what was chosen.
 */
export function QuestionCard({ questions, state, answers, sessionId, requestId, who, autoFocus, className }: QuestionCardProps) {
  const answer = useAnswerApprovals();
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(emptyDraft));
  const [tab, setTab] = useState(0);
  const [row, setRow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const card = useRef<HTMLElement>(null);
  const other = useRef<HTMLInputElement>(null);
  const open = state === 'open' && !!sessionId && !!requestId;
  const q = questions[tab] ?? questions[0]!;
  const draft = drafts[tab] ?? emptyDraft();
  const rows = q.options.length + 1;
  const done = questions.every((x, i) => answered(x, drafts[i] ?? emptyDraft()));

  useEffect(() => {
    if (open && autoFocus && (document.activeElement === document.body || !document.activeElement)) card.current?.focus({ preventScroll: true });
  }, [open, autoFocus]);

  const send = async (a: { decision: 'allow'; answers: Answers } | { decision: 'deny' }) => {
    if (!sessionId || !requestId) return;
    setBusy(true);
    setError(undefined);
    try {
      const { missed, errors } = await answer({ items: [{ sessionId, requestId }], ...a });
      if (missed) setError(errors[0] ?? 'The question is no longer waiting: its run ended.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    if (done && !busy) void send({ decision: 'allow', answers: answersOf(questions, drafts) });
  };

  const goTo = (i: number) => {
    setTab(i);
    setRow(0);
  };
  /** Sets this question's draft; returns every draft as it now is. */
  const update = (next: Draft) => {
    const ds = drafts.map((d, j) => (j === tab ? next : d));
    setDrafts(ds);
    return ds;
  };
  const choose = (i: number) => {
    const next = pick(q, draft, i);
    setRow(i);
    // Picking "Other" means typing it: the field takes focus as it appears, or now if it is there already.
    if (i === otherIndex(q) && next.other) other.current?.focus();
    return update(next);
  };
  /** Enter: on to the first question still unanswered, or submit once none is. */
  const advance = (ds: Draft[]) => {
    const pending = questions.findIndex((x, i) => !answered(x, ds[i] ?? emptyDraft()));
    if (pending < 0) {
      if (!busy) void send({ decision: 'allow', answers: answersOf(questions, ds) });
    } else if (pending !== tab) goTo(pending);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!open || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement) {
      if (e.key === 'Enter') {
        e.preventDefault();
        advance(drafts);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        card.current?.focus();
      }
      return;
    }
    // Out of the card, before Escape means anything else (back from an agent's page, say).
    if (e.key === 'Escape') {
      e.preventDefault();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      return;
    }
    const n = Number(e.key);
    const act: Record<string, () => void> = {
      ArrowDown: () => setRow((r) => Math.min(rows - 1, r + 1)),
      ArrowUp: () => setRow((r) => Math.max(0, r - 1)),
      ArrowRight: () => tab < questions.length - 1 && goTo(tab + 1),
      ArrowLeft: () => tab > 0 && goTo(tab - 1),
      ' ': () => void choose(row),
      // A single choice is made with Enter, as in Claude Code; several are picked with Space first.
      Enter: () => (!q.multiSelect && !isPicked(q, draft, row) ? (row === otherIndex(q) ? void choose(row) : advance(choose(row))) : advance(drafts)),
    };
    const f = Number.isInteger(n) && n >= 1 && n <= rows ? () => void choose(n - 1) : act[e.key];
    if (f) {
      e.preventDefault();
      f();
    }
  };

  const title = questions.length === 1 ? 'Question' : `${questions.length} questions`;
  return (
    <section
      ref={card}
      tabIndex={open ? 0 : undefined}
      onKeyDown={onKey}
      aria-label={who ? `${title} from ${who}` : title}
      className={cn('bg-surf border-ln flex flex-col gap-3 rounded-2xl border p-4 outline-none', open && 'border-wait/60 focus-visible:ring-wait/40 focus-visible:ring-2', className)}
    >
      <header className="flex items-center gap-2 text-sm">
        <MessageCircleQuestionIcon className="text-wait size-4 shrink-0" strokeWidth={2} />
        <span className="font-medium">{title}</span>
        <span className="text-mu truncate text-xs">
          {who && `· ${who} `}· {STATE[state]}
        </span>
      </header>

      {open ? (
        <>
          {questions.length > 1 && (
            <div role="tablist" aria-label="Questions" className="flex flex-wrap gap-1.5">
              {questions.map((x, i) => (
                <button
                  key={x.question}
                  type="button"
                  role="tab"
                  aria-selected={i === tab}
                  onClick={() => goTo(i)}
                  className={cn('flex h-7 items-center gap-1 rounded-full px-3 text-xs font-medium', i === tab ? 'bg-fg text-background' : 'bg-chip text-fg2 hover:bg-raise')}
                >
                  {answered(x, drafts[i] ?? emptyDraft()) && <CheckIcon className="size-3" strokeWidth={2.6} />}
                  {tabLabel(x, i)}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <p className="text-[15px] leading-snug font-medium">
              {questions.length === 1 && q.header && <span className="text-mu mr-1.5 text-xs font-medium tracking-wide uppercase">{q.header}</span>}
              {q.question}
            </p>
            {q.multiSelect && <p className="text-mu -mt-1 text-xs">Pick any that apply.</p>}
            <div role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question} className="flex flex-col gap-1">
              {[...q.options, { label: 'Other', description: undefined }].map((opt, i) => {
                const isOther = i === otherIndex(q);
                const on = isPicked(q, draft, i);
                return (
                  <div key={`${i}:${opt.label}`} className="flex flex-col">
                    <button
                      type="button"
                      role={q.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={on}
                      tabIndex={-1}
                      onClick={() => {
                        choose(i);
                        if (!isOther) card.current?.focus({ preventScroll: true });
                      }}
                      onMouseEnter={() => setRow(i)}
                      className={cn(
                        'flex items-start gap-3 rounded-xl px-3 py-2 text-left',
                        i === row ? 'bg-hov' : 'hover:bg-hov/60',
                        on && 'shadow-[inset_0_0_0_1px_var(--wait)]',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'mt-0.5 flex size-4 shrink-0 items-center justify-center border-[1.5px]',
                          q.multiSelect ? 'rounded-[4px]' : 'rounded-full',
                          on ? 'border-wait bg-wait text-background' : 'border-mu2',
                        )}
                      >
                        {on && (q.multiSelect ? <CheckIcon className="size-3" strokeWidth={3} /> : <span className="bg-background size-1.5 rounded-full" />)}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-fg text-sm font-medium">{isOther ? 'Other' : opt.label}</span>
                        <span className="text-mu text-xs leading-snug">{isOther ? 'Write your own answer' : opt.description}</span>
                      </span>
                      {i < 9 && <Kbd className="bg-chip text-mu2 mt-0.5">{i + 1}</Kbd>}
                    </button>
                    {isOther && draft.other && (
                      <input
                        ref={other}
                        autoFocus
                        value={draft.text}
                        onChange={(e) => update({ ...draft, text: e.target.value })}
                        placeholder="Your answer"
                        aria-label="Your own answer"
                        className="bg-chip text-fg mt-1 ml-10 h-8 min-w-0 rounded-full px-3.5 text-[13px] outline-none"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {tab < questions.length - 1 ? (
              <button type="button" disabled={busy} onClick={() => goTo(tab + 1)} className={cn(btn, 'bg-chip text-fg2 hover:bg-raise')}>
                Next
              </button>
            ) : null}
            <button type="button" disabled={busy || !done} onClick={submit} className={cn(btn, 'bg-acc text-accfg')}>
              Submit
            </button>
            <button type="button" disabled={busy} onClick={() => void send({ decision: 'deny' })} className={cn(btn, 'text-mu hover:bg-hov hover:text-fg')} title="Tell the agent you'd rather not answer">
              Skip
            </button>
            <span className="text-mu2 ml-auto text-[11px] max-sm:hidden">
              ↑↓ move · 1–{Math.min(rows, 9)} pick · {questions.length > 1 ? '←→ questions · ' : ''}Enter {done ? 'submit' : 'next'}
            </span>
          </div>
          {error && <p className="text-fail text-xs">{error}</p>}
        </>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm">
          {questions.map((x, i) => {
            const picked = chosen(answers, x);
            return (
              <li key={x.question} className="flex flex-col">
                <span className="text-mu text-xs">
                  {x.header ? `${x.header} · ` : questions.length > 1 ? `${tabLabel(x, i)} · ` : ''}
                  {x.question}
                </span>
                <span className={cn('text-fg', !picked.length && 'text-mu2 italic')}>
                  {picked.length ? picked.join(', ') : state === 'answered' ? 'Not answered' : state === 'asking' ? 'Putting it to you…' : '—'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
