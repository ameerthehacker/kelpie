import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { MCP_SERVERS, type McpServerList } from '@/lib/mcp-servers';

/**
 * The person's MCP servers, as the daemon last found them (asking Claude Code takes seconds, so it
 * keeps the answer). Only fetched while `enabled`: the setting is on.
 */
export function useMcpServers(enabled: boolean) {
  return useQuery({ queryKey: MCP_SERVERS, queryFn: () => api<McpServerList>('GET', '/api/mcp/servers'), enabled, staleTime: Infinity });
}

/** Asks Claude Code again (servers added, signed in or fixed since), into the same query. */
export function useRefreshMcpServers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<McpServerList>('GET', '/api/mcp/servers?refresh=1'),
    onSuccess: (list) => queryClient.setQueryData(MCP_SERVERS, list),
  });
}
