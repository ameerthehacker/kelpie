import type { Draft } from './questions.js';

/**
 * What the person has picked so far for each open question, by `sessionId:requestId`. The same
 * question shows in the agent's chat and in the queue at once, and its queue row can fold and
 * unfold: kept here, outside either card, the drafts are one, and survive both.
 */
const drafts = new Map<string, Draft[]>();
const listeners = new Set<() => void>();

export const draftKey = (sessionId: string, requestId: string) => `${sessionId}:${requestId}`;

export const getDrafts = (key: string): Draft[] | undefined => drafts.get(key);

export function setDrafts(key: string, ds: Draft[]): void {
  drafts.set(key, ds);
  listeners.forEach((l) => l());
}

/** Forgets a question's drafts, once it has been answered or skipped. */
export function clearDrafts(key: string): void {
  if (drafts.delete(key)) listeners.forEach((l) => l());
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
