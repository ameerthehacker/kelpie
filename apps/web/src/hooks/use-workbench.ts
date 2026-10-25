import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkbenchCard } from '@kelpie/protocol';
import { api } from '@/lib/api';
import { upsertCard } from '@/lib/workbench';

/** Every card on the Workbench: fetched once, then kept live by the daemon's event stream (see use-round-ups). */
export const WORKBENCH = ['workbench'] as const;

export function useWorkbench() {
  const q = useQuery({ queryKey: WORKBENCH, queryFn: () => api<WorkbenchCard[]>('GET', '/api/workbench') });
  return { cards: q.data, error: q.error?.message };
}

/** What the person can do to a card from the board. Each puts the card the daemon answers with on the board. */
export function useCardActions() {
  const queryClient = useQueryClient();
  const put = (card: WorkbenchCard) => queryClient.setQueryData<WorkbenchCard[]>(WORKBENCH, (list) => upsertCard(list, card));
  return {
    /** Takes it off the board ("Remove from Workbench"). */
    archive: (id: string) => api<WorkbenchCard>('PATCH', `/api/workbench/${encodeURIComponent(id)}`, { archived: true }).then(put),
    /** Lands its work; rejects with the daemon's reason (a conflict, uncommitted changes…). */
    merge: (id: string) => api<WorkbenchCard>('POST', `/api/workbench/${encodeURIComponent(id)}/merge`).then(put),
    /** A turn to the card's round-up, as if typed in its chat. */
    say: (roundUpId: string, text: string) => api('POST', `/api/sessions/${roundUpId}/messages`, { text }),
  };
}
