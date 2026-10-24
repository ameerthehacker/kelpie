import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface Branch {
  name: string;
  remote: boolean;
}

/**
 * The branches a round-up in `cwd` may start from (remote first), for the base-branch picker.
 * Undefined while loading, and an empty list outside a git repo.
 */
export function useBranches(cwd: string | undefined) {
  return useQuery({
    queryKey: ['branches', cwd],
    queryFn: () => api<{ branches: Branch[] }>('GET', `/api/repo/branches?cwd=${encodeURIComponent(cwd!)}`).then((r) => r.branches, () => []),
    enabled: !!cwd,
    // Branches come and go outside Kelpie; look again now and then.
    staleTime: 60_000,
  }).data;
}
