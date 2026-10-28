import type { QueryClient } from '@tanstack/react-query';
import { DEFAULT_DELEGATION, DELEGATIONS, type Delegation } from '@kelpie/protocol';
import { api } from './api.js';
import type { RoundUp } from './round-ups.js';

/** How much the orchestrator does itself rather than hands to sub-agents: the protocol's levels, for the app. */
export { DEFAULT_DELEGATION, DELEGATIONS, type Delegation };

/** How each level reads in the composer and Settings. */
export const DELEGATION_INFO: Record<Delegation, { label: string; detail: string }> = {
  solo: { label: 'Solo', detail: 'Kelpie does the work itself; fewest tokens.' },
  balanced: { label: 'Balanced', detail: 'Does small things itself, and delegates big or parallel work.' },
  delegate: { label: 'Delegate', detail: 'Every change goes to sub-agents; Kelpie only coordinates.' },
};

/** A level as the daemon sent it, or the default for one it didn't (an older daemon) or one this app doesn't know. */
export const delegationOf = (v: unknown): Delegation => (DELEGATIONS as readonly unknown[]).includes(v) ? (v as Delegation) : DEFAULT_DELEGATION;

/**
 * Changes a round-up's level. Optimistic, like the mode: the pill answers at once, the daemon's
 * session event confirms it, and a refusal refetches to put it back and rejects.
 */
export async function changeDelegation(queryClient: QueryClient, roundUpId: string, delegation: Delegation): Promise<void> {
  const patch = (r: RoundUp) => (r.id === roundUpId ? { ...r, delegation } : r);
  queryClient.setQueryData<RoundUp[]>(['round-ups'], (list) => list?.map(patch));
  queryClient.setQueryData<RoundUp>(['round-up', roundUpId], (r) => r && patch(r));
  try {
    await api<RoundUp>('PATCH', `/api/sessions/${roundUpId}`, { delegation });
  } catch (err) {
    void queryClient.invalidateQueries({ queryKey: ['round-ups'] });
    void queryClient.invalidateQueries({ queryKey: ['round-up', roundUpId] });
    throw err;
  }
}
