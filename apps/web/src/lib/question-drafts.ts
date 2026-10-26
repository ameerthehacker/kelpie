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

/** Where the person was in each open question (its tab and option): paging back to it in the queue lands there again. */
const places = new Map<string, { tab: number; row: number }>();

export const getPlace = (key: string) => places.get(key);

export const setPlace = (key: string, place: { tab: number; row: number }) => void places.set(key, place);

/** Forgets a question's drafts (and place), once it has been answered or skipped. */
export function clearDrafts(key: string): void {
  places.delete(key);
  if (drafts.delete(key)) listeners.forEach((l) => l());
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
