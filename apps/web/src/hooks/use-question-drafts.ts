import { useCallback, useState, useSyncExternalStore } from 'react';
import type { Question } from '@kelpie/protocol';
import { getDrafts, setDrafts, subscribeDrafts } from '@/lib/question-drafts';
import { emptyDraft, type Draft } from '@/lib/questions';

/**
 * A question card's drafts: shared by every card showing the same question (`key`), or the card's
 * own when it has none (it only shows the questions then).
 */
export function useQuestionDrafts(key: string | undefined, questions: readonly Question[]): [Draft[], (ds: Draft[]) => void] {
  const [initial] = useState(() => questions.map((q) => emptyDraft(q)));
  const [own, setOwn] = useState(initial);
  const shared = useSyncExternalStore(subscribeDrafts, () => (key ? getDrafts(key) : undefined));
  const set = useCallback((ds: Draft[]) => (key ? setDrafts(key, ds) : setOwn(ds)), [key]);
  return [key ? (shared ?? initial) : own, set];
}
