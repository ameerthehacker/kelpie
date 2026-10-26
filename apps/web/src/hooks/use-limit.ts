import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * A session paused at the usage limit: "Resume now" (tried at once) and "Don't auto-resume" (it
 * waits for the person). The daemon's event stream brings the session's new state.
 */
export function useLimitActions(sessionId: string) {
  const resume = useMutation({ mutationFn: () => api('POST', `/api/sessions/${sessionId}/limit/resume`) });
  const cancel = useMutation({ mutationFn: () => api('POST', `/api/sessions/${sessionId}/limit/cancel`) });
  return {
    resumeNow: () => resume.mutate(),
    cancel: () => cancel.mutate(),
    pending: resume.isPending || cancel.isPending,
    error: resume.error?.message ?? cancel.error?.message,
  };
}
