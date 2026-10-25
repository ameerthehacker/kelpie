import { useQuery } from '@tanstack/react-query';
import type { Mode } from '@kelpie/protocol';
import { api } from '@/lib/api';

export interface HarnessInfo {
  harness: string;
  /** In the order Shift+Tab cycles through them. */
  modes: Mode[];
}

/** The harnesses round-ups can run on, and what each offers. */
export function useHarnesses(): HarnessInfo[] | undefined {
  return useQuery({ queryKey: ['harnesses'], queryFn: () => api<HarnessInfo[]>('GET', '/api/harnesses'), staleTime: Infinity }).data;
}
