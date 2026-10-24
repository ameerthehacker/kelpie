import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { HarnessUsage } from '@/lib/usage';

/** Query key for harness usage; the daemon's event stream (see use-round-ups) keeps it current. */
export const USAGE = ['usage'] as const;

export function useUsage() {
  return useQuery({ queryKey: USAGE, queryFn: () => api<HarnessUsage[]>('GET', '/api/usage') });
}
