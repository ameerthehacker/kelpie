import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { KelpieEvent } from '@kelpie/protocol';
import { type AgentSummary } from '@/lib/agents';
import { api } from '@/lib/api';
import { logStream } from '@/lib/live-stream';

export const AGENTS = ['agents'] as const;
export const agentsKey = (roundUpId: string | undefined) => [...AGENTS, roundUpId] as const;

/** Folds an `agent` update from the daemon's event stream into its orchestrator's list. */
export const upsertAgent = (list: AgentSummary[] | undefined, next: AgentSummary) =>
  list && (list.some((a) => a.id === next.id) ? list.map((a) => (a.id === next.id ? next : a)) : [...list, next]);

/**
 * A round-up's sub-agents: fetched, then kept live by the `agent` events the round-up list
 * stream (use-round-ups) writes into the same cache; refetched when that stream reconnects.
 */
export function useAgents(roundUpId: string | undefined) {
  return useQuery({
    queryKey: agentsKey(roundUpId),
    queryFn: () => api<AgentSummary[]>('GET', `/api/sessions/${roundUpId}/agents`),
    enabled: !!roundUpId,
  }).data;
}

/** One round-up's raw KEF log, live: for views that are not a chat (an agent's tab). */
export function useEventLog(id: string | undefined): { events: KelpieEvent[]; error: string | undefined } {
  const [events, setEvents] = useState<KelpieEvent[]>([]);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    setEvents([]);
    setError(undefined);
    if (!id) return;
    return logStream(id, {
      onBatch: (batch) => setEvents((prev) => prev.concat(batch)),
      onGone: () => setError('This agent no longer exists.'),
      onStatus: setError,
    });
  }, [id]);
  return { events, error };
}
