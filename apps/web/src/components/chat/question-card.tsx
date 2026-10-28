import { CheckIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Answers, Question } from '@kelpie/protocol';
import { useAnswerApprovals } from '@/hooks/use-approvals';
import { useQuestionDrafts } from '@/hooks/use-question-drafts';
import type { QuestionView } from '@/lib/chat';
import { clearDrafts, draftKey, getPlace, setPlace } from '@/lib/question-drafts';
import { answered, answersOf, canSubmit, chosen, decide, emptyDraft, isPicked, nextUnanswered, numberProblem, otherIndex, pick, relayedFrom, tabLabel, unrelayed, YOU_DECIDE, type Draft } from '@/lib/questions';
import { cn } from '@/lib/utils';

const STATE: Record<QuestionView['state'], string> = {
  asking: 'Asking…',
  open: 'Waiting for you',
  answered: 'Answered',
  skipped: 'Skipped',
  refused: 'Not asked',
  expired: 'No longer waiting',
};

const btn = 'h-8 shrink-0 rounded-full px-3.5 text-[13px] font-medium disabled:opacity-50';
const field = 'bg-chip text-fg h-8 min-w-0 rounded-full px-3.5 text-[13px] outline-none focus-visible:ring-acc/40 focus-visible:ring-2';
/** A scrolling body whose edges fade out (only its padding, until there is more to scroll to), with a quiet scrollbar. */
const fade =
  '[mask-image:linear-gradient(to_bottom,transparent,#000_12px,#000_calc(100%_-_12px),transparent)] [scrollbar-color:var(--ln2)_transparent] [scrollbar-width:thin]';

/** Where the keyboard goes once the card has rendered what a key changed. */
type FocusTo = 'current' | 'tab' | 'other';

export interface QuestionCardProps {
  questions: Question[];
  state: QuestionView['state'];
  /** What was chosen, once answered. */
  answers?: Answers | undefined;
  /** Where to send the answers; without both, the card only shows the questions. */
  sessionId: string | undefined;
  requestId: string | undefined;
  /** Who asks: the agent whose card it is ("Kelpie" for an orchestrator). */
  who?: string;
  /**
   * The round-up's agents, where the asker is its orchestrator: a question it passes on from one
   * of them ("Checkout API asks: …") is that agent's call (see `relayedFrom`).
   */
  relayFrom?: readonly string[];
  /** Take the keyboard as it opens, unless something else (the composer) has it. */
  autoFocus?: boolean;
  /** Take the keyboard as it opens, whatever has it: the person asked to answer. */
  takeFocus?: boolean;
  /**
   * `card`: a card of its own, with a header saying what it is (in a chat). `bare`: just the
   * questions, for a container that has its own chrome (the tray): its body scrolls, its buttons stay put.
   */
  variant?: 'card' | 'bare';
  /** Bare: whether its body scrolls within it (false where the page around it scrolls, so there is one scroll). */
  scroll?: boolean;
  className?: string;
}

/**
 * Questions an agent puts to the person, as Claude Code's picker has them: each with its options
 * (one to pick, or several), and their own answer under "Other"; or a box for words or a number.
 * Several questions are tabs in one card, and any may be left unanswered. Keys, on an option:
 * ↑/↓ to move, 1–9 or Space to pick, ←/→ between questions, Enter for the next question or to
 * submit. Escape stays in the card. What is picked is kept per question, so the agent's chat and
 * the queue show the same. Answered, it folds to what was chosen.
 */
export function QuestionCard({ questions, state, answers, sessionId, requestId, who: asker, relayFrom, autoFocus, takeFocus, variant = 'card', scroll = true, className }: QuestionCardProps) {
  const answer = useAnswerApprovals();
  const relayed = relayFrom && relayedFrom(questions, relayFrom);
  const who = relayed ?? asker;
  const key = sessionId && requestId ? draftKey(sessionId, requestId) : undefined;
  const [drafts, setDrafts] = useQuestionDrafts(key, questions);
  // Where the person left this question, if they paged away from it in the queue.
  const [tab, setTab] = useState(() => Math.max(0, Math.min((key && getPlace(key)?.tab) || 0, questions.length - 1)));
  const [row, setRow] = useState(() => (key && getPlace(key)?.row) || 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const focusTo = useRef<FocusTo | undefined>(undefined);
  const open = state === 'open' && !!sessionId && !!requestId;
  const q = questions[tab] ?? questions[0]!;
  const draft = drafts[tab] ?? emptyDraft(q);
  const rows = q.kind ? 0 : q.options.length + 1;
  const ready = canSubmit(questions, drafts);
  const last = nextUnanswered(questions, drafts, tab) < 0;
  const problem = numberProblem(q, draft.text);
  const preview = !q.multiSelect && q.options.some((o) => o.preview) ? q.options[row]?.preview : undefined;

  /** The keyboard's place on this question: its highlighted option, or its box. */
  const focusCurrent = () => panel.current?.querySelector<HTMLElement>(q.kind ? 'input' : `[data-row="${row}"]`)?.focus({ preventScroll: true });

  useEffect(() => {
    const to = focusTo.current;
    focusTo.current = undefined;
    if (to === 'tab') tabs.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    else if (to === 'other') panel.current?.querySelector<HTMLElement>('input')?.focus();
    else if (to === 'current') focusCurrent();
  });
  useEffect(() => {
    if (key) setPlace(key, { tab, row });
  }, [key, tab, row]);
  useEffect(() => {
    if (open && (takeFocus || (autoFocus && (document.activeElement === document.body || !document.activeElement)))) focusCurrent();
    // Only as it opens: never again while the person is elsewhere.
  }, [open, autoFocus, takeFocus]);

  const send = async (a: { decision: 'allow'; answers: Answers } | { decision: 'deny' }) => {
    if (!sessionId || !requestId) return;
    setBusy(true);
    setError(undefined);
    try {
      const { missed, errors } = await answer({ items: [{ sessionId, requestId }], ...a });
      if (missed) setError(errors[0] ?? 'The question is no longer waiting: its run ended.');
      else if (key) clearDrafts(key);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = (ds: Draft[]) => {
    if (busy) return;
    if (canSubmit(questions, ds)) void send({ decision: 'allow', answers: answersOf(questions, ds) });
    else setError(questions.some((x, i) => numberProblem(x, ds[i]?.text ?? '')) ? 'One of the numbers is out of its range.' : 'Answer at least one question, or skip them.');
  };

  const goTo = (i: number, to: FocusTo) => {
    setTab(i);
    setRow(0);
    focusTo.current = to;
  };
  /** Sets this question's draft; returns every draft as it now is. */
  const update = (next: Draft) => {
    const ds = questions.map((x, j) => (j === tab ? next : (drafts[j] ?? emptyDraft(x))));
    setDrafts(ds);
    return ds;
  };
  const choose = (i: number) => {
    // Out of "You decide": the person makes the call after all.
    const next = pick(q, draft.other && draft.text === YOU_DECIDE ? { ...draft, other: false, text: '' } : draft, i);
    setRow(i);
    // Picking "Other" means typing it: the box takes the keyboard as it appears.
    focusTo.current = i === otherIndex(q) && next.other ? 'other' : 'current';
    return update(next);
  };
  /** Enter: on to the next question still unanswered, or submit once none is. */
  const advance = (ds: Draft[]) => {
    const n = nextUnanswered(questions, ds, tab);
    if (n < 0) submit(ds);
    else goTo(n, 'current');
  };

  const onKey = (e: KeyboardEvent) => {
    if (!open || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    // Escape never leaves the page from in here: from the box it goes back to the options.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (t instanceof HTMLInputElement && !q.kind) {
        setRow(otherIndex(q));
        panel.current?.querySelector<HTMLElement>(`[data-row="${otherIndex(q)}"]`)?.focus();
      }
      return;
    }
    if (t instanceof HTMLInputElement) {
      if (e.key === 'Enter') {
        e.preventDefault();
        advance(drafts);
      }
      return;
    }
    if (t.getAttribute('role') === 'tab') {
      const to = e.key === 'ArrowRight' ? tab + 1 : e.key === 'ArrowLeft' ? tab - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? questions.length - 1 : -1;
      if (to >= 0 && to < questions.length) {
        e.preventDefault();
        goTo(to, 'tab');
      }
      return;
    }
    // Skip, Next and Submit keep their own keys; only the options take the card's.
    if (t.dataset.row === undefined) return;
    const n = Number(e.key);
    const move = (r: number) => {
      setRow(r);
      focusTo.current = 'current';
    };
    const act: Record<string, () => void> = {
      ArrowDown: () => move(Math.min(rows - 1, row + 1)),
      ArrowUp: () => move(Math.max(0, row - 1)),
      Home: () => move(0),
      End: () => move(rows - 1),
      ArrowRight: () => tab < questions.length - 1 && goTo(tab + 1, 'current'),
      ArrowLeft: () => tab > 0 && goTo(tab - 1, 'current'),
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
  const tabId = (i: number) => `${id}-tab-${i}`;
  const bare = variant === 'bare';
  const waiting = state === 'open' || state === 'asking';
  return (
    <section
      onKeyDown={onKey}
      data-question-card=""
      aria-label={who ? `${title} from ${who}` : title}
      // The design's "needs a call" card: pale amber while it waits on the person, quiet once settled.
      className={cn('group/q flex flex-col', bare ? 'min-h-0' : cn('rounded-xl', waiting ? 'bg-wbg' : 'bg-well'), className)}
    >
      {!bare && (
        <header className={cn('flex items-center gap-1.5 px-4 pt-3.5 text-[13px] font-medium', waiting ? 'text-wait' : 'text-mu')}>
          <span aria-hidden="true" className="text-[10px]">
            ◆
          </span>
          <span className="truncate">
            {who ?? 'Kelpie'} {waiting ? 'needs a call' : 'asked'}
            {questions.length > 1 && ` · ${questions.length} questions`}
          </span>
          {!waiting && <span className="text-mu2 shrink-0 font-normal">· {STATE[state]}</span>}
        </header>
      )}

      {open ? (
        <>
          {questions.length > 1 && (
            <div
              ref={tabs}
              role="tablist"
              aria-label="Questions"
              className={cn('bg-chip dark:bg-well mx-4 flex w-fit max-w-[calc(100%-2rem)] shrink-0 flex-wrap gap-0.5 rounded-[10px] p-0.5', !bare && 'mt-3')}
            >
              {questions.map((x, i) => (
                <button
                  key={i}
                  id={tabId(i)}
                  type="button"
                  role="tab"
                  aria-selected={i === tab}
                  aria-controls={`${id}-panel`}
                  tabIndex={i === tab ? 0 : -1}
                  onClick={() => goTo(i, 'tab')}
                  className={cn(
                    'focus-visible:ring-acc/40 flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium outline-none focus-visible:ring-2',
                    i === tab ? 'bg-surf dark:bg-raise text-fg shadow-xs' : 'text-mu hover:text-fg',
                  )}
                >
                  {answered(x, drafts[i] ?? emptyDraft(x)) && <CheckIcon aria-hidden="true" className="text-acc size-3" strokeWidth={2.6} />}
                  {tabLabel(x, i)}
                  {answered(x, drafts[i] ?? emptyDraft(x)) && <span className="sr-only">, answered</span>}
                </button>
              ))}
            </div>
          )}
          <div
            ref={panel}
            id={`${id}-panel`}
            {...(questions.length > 1 ? { role: 'tabpanel', 'aria-labelledby': tabId(tab) } : {})}
            className={cn('flex flex-col gap-2 px-4', bare && scroll ? cn('min-h-24 flex-1 overflow-y-auto py-3', fade) : bare ? 'py-3' : 'pt-3')}
          >
            <p id={`${id}-q`} className="text-[15px] leading-snug font-medium">
              {questions.length === 1 && q.header && <span className="text-mu mr-1.5 text-xs font-medium tracking-wide uppercase">{q.header}</span>}
              {unrelayed(q.question, relayed)}
            </p>
            {q.description && <p className="text-mu -mt-1 text-xs">{q.description}</p>}
            {q.kind === 'text' ? (
              <input
                value={draft.text}
                onChange={(e) => update({ ...draft, text: e.target.value })}
                placeholder={q.placeholder ?? 'Your answer'}
                aria-labelledby={`${id}-q`}
                className={field}
              />
            ) : q.kind === 'number' ? (
              <div className="flex flex-col gap-1">
                <span className="flex items-center gap-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    value={draft.text}
                    min={q.min}
                    max={q.max}
                    step={q.step ?? 'any'}
                    onChange={(e) => update({ ...draft, text: e.target.value })}
                    placeholder={q.min !== undefined && q.max !== undefined ? `${q.min}–${q.max}` : 'A number'}
                    aria-labelledby={`${id}-q`}
                    aria-invalid={!!problem}
                    aria-describedby={problem ? `${id}-problem` : undefined}
                    className={cn(field, 'w-32')}
                  />
                  {q.unit && <span className="text-mu text-[13px]">{q.unit}</span>}
                </span>
                {problem && (
                  <p id={`${id}-problem`} className="text-fail text-xs">
                    {problem}
                  </p>
                )}
              </div>
            ) : (
              <>
                {q.multiSelect && <p className="text-mu -mt-1 text-xs">Pick any that apply.</p>}
                {/* The design's pills: one per option, then "Other" to write their own, and "You decide" to leave it to the asker. */}
                <div role={q.multiSelect ? 'group' : 'radiogroup'} aria-labelledby={`${id}-q`} className="flex flex-wrap items-center gap-1.5">
                  {[...q.options, { label: 'Other', description: 'Write your own answer' }].map((opt, i) => {
                    const isOther = i === otherIndex(q);
                    const on = isPicked(q, draft, i) && !(isOther && draft.text === YOU_DECIDE);
                    return (
                      <button
                        key={`${i}:${opt.label}`}
                        type="button"
                        role={q.multiSelect ? 'checkbox' : 'radio'}
                        aria-checked={on}
                        aria-description={opt.description}
                        title={opt.description}
                        data-row={i}
                        tabIndex={i === row ? 0 : -1}
                        onClick={() => void choose(i)}
                        onMouseEnter={() => setRow(i)}
                        className={cn(
                          'focus-visible:ring-acc/50 flex h-8 max-w-full items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium outline-none focus-visible:ring-2',
                          on ? 'border-acc bg-acc text-accfg' : cn('bg-surf border-ln hover:border-ln2', isOther ? 'text-mu' : 'text-fg'),
                        )}
                      >
                        {on && q.multiSelect && <CheckIcon aria-hidden="true" className="size-3.5" strokeWidth={2.6} />}
                        <span className="truncate">{isOther ? 'Other…' : opt.label}</span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    aria-pressed={draft.other && draft.text === YOU_DECIDE}
                    disabled={busy}
                    onClick={() => advance(update(decide(draft)))}
                    title="Leave the call to whoever asked"
                    className="text-mu hover:text-fg aria-pressed:text-acc px-2 text-[13px] font-medium underline-offset-2 hover:underline"
                  >
                    {YOU_DECIDE}
                  </button>
                </div>
                {/* What the option in reach means: pills have no room for it. */}
                {q.options[row]?.description && <p className="text-mu -mt-0.5 text-xs leading-snug">{q.options[row].description}</p>}
                {draft.other && draft.text !== YOU_DECIDE && (
                  <input value={draft.text} onChange={(e) => update({ ...draft, text: e.target.value })} placeholder="Your answer" aria-label="Your own answer" className={field} />
                )}
                {preview && <pre className="bg-chip text-fg2 max-h-60 overflow-auto rounded-xl p-3 font-mono text-xs leading-snug">{preview}</pre>}
              </>
            )}
          </div>
          <div className={cn('flex shrink-0 items-center gap-1.5 px-4', bare ? 'border-ln border-t py-2.5' : 'pt-3 pb-3.5')}>
            <button type="button" disabled={busy || !ready} onClick={() => submit(drafts)} className={cn(btn, 'bg-acc text-accfg')}>
              Submit
            </button>
            {tab < questions.length - 1 ? (
              <button type="button" disabled={busy} onClick={() => goTo(tab + 1, 'current')} className={cn(btn, 'bg-chip text-fg2 hover:bg-raise')}>
                Next
              </button>
            ) : null}
            <button type="button" disabled={busy} onClick={() => void send({ decision: 'deny' })} className={cn(btn, 'text-mu hover:bg-raise hover:text-fg')} title="Tell the agent you'd rather not answer">
              Skip
            </button>
            {error ? (
              <p role="alert" className="text-fail ml-auto min-w-0 truncate text-xs" title={error}>
                {error}
              </p>
            ) : (
              <span className="text-mu2 ml-auto min-w-0 truncate text-[11px] max-sm:hidden">
                {rows ? `↑↓ move · 1–${Math.min(rows, 9)} pick · ` : ''}
                {questions.length > 1 && rows ? '←→ questions · ' : ''}Enter {last ? 'submit' : 'next'}
              </span>
            )}
          </div>
        </>
      ) : (
        <ul className="flex flex-col gap-1.5 px-4 pt-2.5 pb-3.5 text-sm">
          {questions.map((x, i) => {
            const picked = chosen(answers, x);
            return (
              <li key={i} className="flex flex-col gap-0.5">
                <span className="text-fg font-medium">
                  {questions.length > 1 && <span className="text-mu mr-1.5 text-xs font-normal">{x.header || tabLabel(x, i)}</span>}
                  {unrelayed(x.question, relayed)}
                </span>
                <span className={cn('text-mu', !picked.length && 'text-mu2 italic')}>
                  {picked.length ? `${picked.join(', ')}${state === 'answered' ? ' — resumed.' : ''}` : state === 'answered' ? 'Not answered' : state === 'asking' ? 'Putting it to you…' : '—'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
