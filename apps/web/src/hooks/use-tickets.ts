import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * The person's edits to a round-up's tickets: naming one (an empty title clears their name) and
 * unlinking one. The round-up's event stream brings the change back to every view.
 */
export function useTicketEdits(roundUpId: string) {
  const url = (ref: string) => `/api/sessions/${roundUpId}/tickets/${encodeURIComponent(ref)}`;
  const rename = useMutation({ mutationFn: ({ ref, title }: { ref: string; title: string }) => api('PATCH', url(ref), { title }) });
  const unlink = useMutation({ mutationFn: (ref: string) => api('DELETE', url(ref)) });
  return { rename, unlink, error: rename.error ?? unlink.error };
}
