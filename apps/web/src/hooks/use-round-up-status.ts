import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { RoundUp } from '@/lib/round-ups';
import { roundUpStatus, type PlanGroup } from '@/lib/status';
import { useApprovals } from './use-approvals';

/** Every round-up's sub-agents, as sessions: filled and kept current by the daemon's event stream (see use-round-ups). */
export const SUB_AGENTS = ['sub-agents'] as const;

/** Folds a sub-agent's `session` update into the list. */
export const upsertSubAgent = (list: RoundUp[] = [], next: RoundUp) => [...list.filter((s) => s.id !== next.id), next];

/** Drops a deleted session, and with a round-up, its sub-agents. */
export const dropSession = (list: RoundUp[] | undefined, id: string) => list?.filter((s) => s.id !== id && s.parentId !== id);

/** Each round-up's dot, from its orchestrator, its sub-agents and what it is waiting on the person for. Live. */
export function useRoundUpStatus(): (roundUp: RoundUp) => PlanGroup | undefined {
  // Never fetched: the stream sends a snapshot as it connects, then every change.
  const subAgents = useQuery({ queryKey: SUB_AGENTS, queryFn: () => [] as RoundUp[], enabled: false, initialData: [] }).data;
  const approvals = useApprovals();
  return useCallback((roundUp) => roundUpStatus(roundUp, subAgents, approvals), [subAgents, approvals]);
}
