import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * "Stop all" and "Resume all" for a round-up, and resuming one agent the person stopped. The
 * daemon's event stream brings the new states (and the chat its line).
 */
export function useHaltActions(roundUpId: string | undefined) {
  const stop = useMutation({ mutationFn: (orchestrator: boolean) => api('POST', `/api/sessions/${roundUpId}/stop-all`, { orchestrator }) });
  const resume = useMutation({ mutationFn: () => api('POST', `/api/sessions/${roundUpId}/resume-all`) });
  // Only the latest action's error shows: an old one goes once the person tries again.
  return {
    stopAll: (orchestrator = true) => {
      resume.reset();
      stop.mutate(orchestrator);
    },
    resumeAll: () => {
      stop.reset();
      resume.mutate();
    },
    pending: stop.isPending || resume.isPending,
    error: stop.error?.message ?? resume.error?.message,
  };
}

/** One agent the person stopped, resumed on its own. */
export function useResumeAgent(agentId: string) {
  const resume = useMutation({ mutationFn: () => api('POST', `/api/sessions/${agentId}/resume`) });
  return { resume: () => resume.mutate(), pending: resume.isPending, error: resume.error?.message };
}
