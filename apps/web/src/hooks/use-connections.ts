import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** A connector as the daemon reports it (packages/daemon/src/connectors). It never carries the secret. */
export interface ConnectionStatus {
  id: string;
  name: string;
  /** A credential is there and was not refused when last checked. */
  connected: boolean;
  /** `gh` (the person's gh CLI login) or `token` (pasted, stored by Kelpie). */
  method?: string;
  account?: { login: string; name?: string; avatarUrl?: string; url?: string };
  /** Null when the service doesn't list them (a fine-grained token). */
  scopes?: string[] | null;
  error?: string;
  cli?: { name: string; installed: boolean; loggedIn: boolean };
  checkedAt: number;
}

const CONNECTIONS = ['connections'] as const;

/** Every connector's status. The daemon re-checks one that is a few minutes old. */
export function useConnections() {
  return useQuery({ queryKey: CONNECTIONS, queryFn: () => api<ConnectionStatus[]>('GET', '/api/connections'), staleTime: 60_000 });
}

/** Connect (with a token), check again and disconnect one connector; each answer replaces its status. */
export function useConnection(id: string) {
  const queryClient = useQueryClient();
  const put = (status: ConnectionStatus) => queryClient.setQueryData<ConnectionStatus[]>(CONNECTIONS, (rows) => rows?.map((r) => (r.id === status.id ? status : r)));
  const path = `/api/connections/${encodeURIComponent(id)}`;
  return {
    connect: useMutation({ mutationFn: (token: string) => api<ConnectionStatus>('POST', path, { token }), onSuccess: put }),
    check: useMutation({ mutationFn: () => api<ConnectionStatus>('POST', `${path}/check`), onSuccess: put }),
    disconnect: useMutation({ mutationFn: () => api<ConnectionStatus>('DELETE', path), onSuccess: put }),
  };
}
