import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { HarnessStatus } from '@kelpie/protocol';

const HARNESS_STATUS = ['harness-status'] as const;

/**
 * Whether each harness CLI is installed and signed in. Unlike round-up data nothing pushes this, so it
 * is never fresh: it is checked again on every mount and whenever the window regains focus (back from
 * the terminal after installing), and `refetch()` is "Check again".
 */
export function useHarnessStatus() {
  return useQuery({
    queryKey: HARNESS_STATUS,
    queryFn: () => api<HarnessStatus[]>('GET', '/api/harnesses/status'),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}
