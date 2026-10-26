import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Answers, Mode } from '@kelpie/protocol';
import { api } from '@/lib/api';
import type { PendingApproval, SavedRule } from '@/lib/approvals';

/** Every round-up's pending approvals: filled and kept current by the daemon's event stream (see use-round-ups). */
export const APPROVALS = ['approvals'] as const;
export const rulesKey = (roundUpId: string) => ['rules', roundUpId] as const;

/** What one round-up (or, without an id, every round-up) is waiting on the person for. */
export function useApprovals(roundUpId?: string): PendingApproval[] {
  // Never fetched: the stream sends a snapshot as it connects, then every change.
  const all = useQuery({ queryKey: APPROVALS, queryFn: () => [] as PendingApproval[], enabled: false, initialData: [] }).data;
  return useMemo(() => (roundUpId ? all.filter((a) => a.roundUpId === roundUpId) : all), [all, roundUpId]);
}

/** The rules the person saved for a round-up. */
export function useRules(roundUpId: string | undefined): SavedRule[] {
  return (
    useQuery({
      queryKey: rulesKey(roundUpId ?? ''),
      queryFn: () => api<{ rules: SavedRule[] }>('GET', `/api/approvals?roundUp=${roundUpId}`).then((r) => r.rules),
      enabled: !!roundUpId,
    }).data ?? []
  );
}

export interface Answer {
  items: Pick<PendingApproval, 'sessionId' | 'requestId'>[];
  decision: 'allow' | 'deny';
  message?: string;
  /** Save each one's rule for its round-up. */
  remember?: boolean;
  /** For a plan: the mode the round-up leaves plan mode for. */
  mode?: Mode;
  /** For questions (one item, allowed): the person's answers, by question text. */
  answers?: Answers;
}

/** Answers a batch; the stream then takes the answered ones off every view. */
export function useAnswerApprovals() {
  const queryClient = useQueryClient();
  return async (answer: Answer) => {
    const { results } = await api<{ results: { ok: boolean; error?: string }[] }>('POST', '/api/approvals', answer);
    if (answer.remember) void queryClient.invalidateQueries({ queryKey: ['rules'] });
    const failed = results.filter((r) => !r.ok);
    // Already answered elsewhere, or the run ended: nothing to do, and the stream has it.
    return { answered: results.length - failed.length, missed: failed.length, errors: failed.flatMap((r) => (r.error ? [r.error] : [])) };
  };
}

export function useForgetRule(roundUpId: string) {
  const queryClient = useQueryClient();
  return async (id: number) => {
    await api('DELETE', `/api/sessions/${roundUpId}/rules/${id}`);
    await queryClient.invalidateQueries({ queryKey: rulesKey(roundUpId) });
  };
}
