import type { Answers, Question } from '@kelpie/protocol';

/**
 * What the person has picked for one question so far: options by index, and their own answer
 * ("Other"), which counts once they turn it on and write something. A text or number question has
 * only `text`.
 */
export interface Draft {
  picked: number[];
  other: boolean;
  text: string;
}

/** Nothing picked yet; a number question starts at its default, as the CLI's own control does. */
export const emptyDraft = (q?: Question): Draft => ({
  picked: [],
  other: false,
  text: q?.kind === 'number' && q.defaultValue !== undefined ? String(q.defaultValue) : '',
});

/** Why a number question's answer won't do (not a number, or out of its range); undefined if it will, or is empty. */
export function numberProblem(q: Question, text: string): string | undefined {
  const t = text.trim();
  if (q.kind !== 'number' || !t) return undefined;
  const n = Number(t);
  const range = q.min !== undefined && q.max !== undefined ? `from ${q.min} to ${q.max}` : q.min !== undefined ? `${q.min} or more` : q.max !== undefined ? `${q.max} or less` : '';
  if (!/^-?\d+(\.\d+)?$/.test(t) || (q.min !== undefined && n < q.min) || (q.max !== undefined && n > q.max)) return `A number${range ? ` ${range}` : ''}`;
  return undefined;
}

/** The row index that stands for "Other": the one after the options. */
export const otherIndex = (q: Question) => q.options.length;

/**
 * Picks row `i` of a question (an option, or "Other"). One choice replaces the last; with
 * multiSelect, each row toggles.
 */
export function pick(q: Question, d: Draft, i: number): Draft {
  if (q.kind || i < 0 || i > otherIndex(q)) return d;
  const isOther = i === otherIndex(q);
  if (!q.multiSelect) return isOther ? { ...d, picked: [], other: true } : { ...d, picked: [i], other: false };
  if (isOther) return { ...d, other: !d.other };
  return { ...d, picked: d.picked.includes(i) ? d.picked.filter((x) => x !== i) : [...d.picked, i].sort((a, b) => a - b) };
}

/** Whether row `i` is chosen. */
export const isPicked = (q: Question, d: Draft, i: number) => (i === otherIndex(q) ? d.other : d.picked.includes(i));

/** The question's answer as the agent gets it: labels, and the person's own words; empty if none yet. */
export function answerOf(q: Question, d: Draft): string[] {
  if (q.kind) return d.text.trim() && !numberProblem(q, d.text) ? [d.text.trim()] : [];
  const labels = d.picked.flatMap((i) => (q.options[i] ? [q.options[i].label] : []));
  const own = d.other ? d.text.trim() : '';
  return own ? [...labels, own] : labels;
}

export const answered = (q: Question, d: Draft) => answerOf(q, d).length > 0;

/** Whether the answers can go: any question may be left unanswered, but not all, and no number may be off. */
export const canSubmit = (questions: readonly Question[], drafts: readonly Draft[]) =>
  questions.some((q, i) => answered(q, drafts[i] ?? emptyDraft(q))) && !questions.some((q, i) => numberProblem(q, drafts[i]?.text ?? ''));

/** Where Enter goes from question `tab`: the next one after it still unanswered, or -1 to submit. */
export function nextUnanswered(questions: readonly Question[], drafts: readonly Draft[], tab: number): number {
  for (let i = tab + 1; i < questions.length; i++) if (!answered(questions[i]!, drafts[i] ?? emptyDraft(questions[i]))) return i;
  return -1;
}

/** Every answered question's answer, by its text: a single choice as a string, a multi-select as a list. */
export function answersOf(questions: readonly Question[], drafts: readonly Draft[]): Answers {
  const out: Answers = {};
  questions.forEach((q, i) => {
    const a = answerOf(q, drafts[i] ?? emptyDraft(q));
    if (a.length) out[q.question] = q.multiSelect ? a : a[0]!;
  });
  return out;
}

/** What was answered to a question, as a list, from what the daemon logged; a number with its unit. */
export function chosen(answers: Answers | undefined, q: Question): string[] {
  const a = answers?.[q.question];
  const list = a === undefined ? [] : Array.isArray(a) ? a : [a];
  return q.kind === 'number' && q.unit ? list.map((x) => `${x} ${q.unit}`) : list;
}

/** A tab's label: the question's header, or its number. */
export const tabLabel = (q: Question, i: number) => q.header || `Question ${i + 1}`;

/** "Asks: Which color…" or "Asks 3 questions", for a queue row. */
export function questionsLine(questions: readonly Question[]): string {
  return questions.length === 1 ? questions[0]!.question : `${questions.length} questions: ${questions.map((q, i) => tabLabel(q, i)).join(', ')}`;
}
