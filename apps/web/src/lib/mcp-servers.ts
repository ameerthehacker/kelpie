import type { McpScope, McpServerInfo, McpServerList, McpStatus } from '@kelpie/protocol';

export type { McpScope, McpServerInfo, McpServerList, McpStatus };

/** Query key for the person's MCP servers. */
export const MCP_SERVERS = ['mcp-servers'] as const;

export const SCOPE_LABEL: Record<McpScope, string> = { user: 'User', project: 'Project', local: 'Local', claudeai: 'claude.ai' };

export const STATUS_LABEL: Record<McpStatus, string> = {
  connected: 'Connected',
  failed: 'Failed to connect',
  'needs-auth': 'Needs sign-in',
  pending: 'Connecting',
  unchecked: 'Not checked',
};

/** The allowlist with one server turned on or off, in a steady order (the list's, then any others). */
export function toggleAllow(allow: readonly string[], name: string, on: boolean, order: readonly string[] = []): string[] {
  const next = new Set(allow);
  if (on) next.add(name);
  else next.delete(name);
  const rank = (n: string) => (order.includes(n) ? order.indexOf(n) : order.length);
  return [...next].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** A row in Settings: a server Claude Code has, or one allowed that it no longer has (so it can be turned off). */
export interface McpRow {
  name: string;
  server: McpServerInfo | undefined;
  allowed: boolean;
  /** Can be ticked: there, and not named like Kelpie's own. */
  selectable: boolean;
}

export function mcpRows(servers: readonly McpServerInfo[], allow: readonly string[]): McpRow[] {
  const rows: McpRow[] = servers.map((s) => ({ name: s.name, server: s, allowed: allow.includes(s.name) && !s.blocked, selectable: !s.blocked }));
  for (const name of allow) if (!servers.some((s) => s.name === name)) rows.push({ name, server: undefined, allowed: true, selectable: true });
  return rows;
}

/** "2 of 3 servers allowed", for the switch's summary. */
export function allowedSummary(rows: readonly McpRow[]): string {
  const there = rows.filter((r) => r.server);
  const on = there.filter((r) => r.allowed).length;
  return there.length ? `${on} of ${there.length} server${there.length === 1 ? '' : 's'} allowed` : 'No servers found';
}
