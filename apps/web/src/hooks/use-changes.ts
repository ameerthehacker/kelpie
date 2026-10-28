import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ChangedFile, Changes } from '@/lib/changes';

export const CHANGES = 'changes';
/** `['changes', sessionId]` is the prefix the event stream invalidates. */
export const changesKey = (sessionId: string | undefined, round?: number, patches = true) => [CHANGES, sessionId, round ?? null, patches] as const;

const query = (round: number | undefined, patches: boolean) => {
  const q = new URLSearchParams();
  if (!patches) q.set('patches', '0');
  if (round !== undefined) q.set('round', String(round));
  const s = q.toString();
  return s ? `?${s}` : '';
};

/**
 * What a round-up's feature branch, or one agent's branch, changed. Without patches it is just the
 * file list (for a tab's count). Kept current by the stream's `changes` events, and polled while
 * an agent is still at work on files it has not committed. `enabled: false` only reads what is
 * already fetched: for one of many rows, until the person opens it.
 */
export function useChanges(
  sessionId: string | undefined,
  { round, patches = true, working = false, enabled = true }: { round?: number; patches?: boolean; working?: boolean; enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: changesKey(sessionId, round, patches),
    queryFn: () => api<Changes>('GET', `/api/sessions/${sessionId}/changes${query(round, patches)}`),
    enabled: !!sessionId && enabled,
    refetchInterval: working ? 15_000 : false,
    placeholderData: (prev) => (prev?.sessionId === sessionId ? prev : undefined),
  });
}

/** One file's patch, fetched on its own: a file too large to come with the rest. */
export function useChangedFile(sessionId: string, path: string, round: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [CHANGES, sessionId, round ?? null, 'file', path],
    queryFn: () => {
      const q = new URLSearchParams({ path });
      if (round !== undefined) q.set('round', String(round));
      return api<ChangedFile>('GET', `/api/sessions/${sessionId}/changes/file?${q}`);
    },
    enabled,
    staleTime: Infinity,
  });
}
