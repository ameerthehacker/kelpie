import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { mcpServersKey, type McpServerList } from '@/lib/mcp-servers';

/**
 * The person's MCP servers for round-ups in `repo` (default: Kelpie's own), as the daemon last
 * found them: reading starts nothing. Only fetched while `enabled`: the setting is on.
 */
export function useMcpServers(enabled: boolean, repo: string | undefined) {
  return useQuery({
    queryKey: mcpServersKey(repo),
    queryFn: () => api<McpServerList>('GET', `/api/mcp/servers${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`),
    enabled,
    staleTime: Infinity,
  });
}

/** Asks Claude Code again about a repo (servers added, signed in or fixed since): it starts them, so it takes seconds. */
export function useRefreshMcpServers() {
  const queryClient = useQueryClient();
  return useMutation({
    // `shown`: the repo the list is shown under (undefined for Kelpie's own, before one is picked).
    mutationFn: ({ repo }: { repo: string; shown: string | undefined }) => api<McpServerList>('POST', '/api/mcp/servers/refresh', { repo }),
    onSuccess: (list, { shown }) => queryClient.setQueryData(mcpServersKey(shown), list),
  });
}
