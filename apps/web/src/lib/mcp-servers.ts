import { grantKey, type McpGrant, type McpScope, type McpServerInfo, type McpServerList, type McpStatus } from '@kelpie/protocol';

export type { McpGrant, McpScope, McpServerInfo, McpServerList, McpStatus };

/** Query key for the person's MCP servers in one repo. */
export const mcpServersKey = (repo: string | undefined) => ['mcp-servers', repo ?? ''] as const;

export const SCOPE_LABEL: Record<McpScope, string> = { user: 'User', project: 'Project', local: 'Local', claudeai: 'claude.ai' };

export const STATUS_LABEL: Record<McpStatus, string> = {
  connected: 'Connected',
  failed: 'Failed to connect',
  'needs-auth': 'Needs sign-in',
  pending: 'Connecting',
  unchecked: 'Not checked',
};

/**
 * A row in Settings. `allowed`: agents get it. `changed`: allowed once, but its entry (what it runs,
 * where it connects, its settings) is not what it was then, so agents don't get it until it's ticked again. `blocked`: its name could
 * pass for another server's tools. `missing`: allowed, but Claude Code no longer has it here.
 */
export type McpRowState = 'allowed' | 'changed' | 'off' | 'blocked' | 'missing';

export interface McpRow {
  key: string;
  name: string;
  server: McpServerInfo | undefined;
  grant: McpGrant | undefined;
  state: McpRowState;
}

/** Whether a grant is for servers seen from `repo`: one not tied to a repo, or to `repo` or a directory above it. */
const appliesTo = (g: McpGrant, repo: string) => !g.repo || g.repo === repo || repo.startsWith(g.repo.endsWith('/') ? g.repo : `${g.repo}/`);

export function mcpRows(servers: readonly McpServerInfo[], grants: readonly McpGrant[], repo: string): McpRow[] {
  const byKey = new Map(grants.map((g) => [grantKey(g), g]));
  const rows: McpRow[] = servers.map((s) => {
    const key = grantKey(s);
    const grant = byKey.get(key);
    const state: McpRowState = s.blocked ? 'blocked' : !grant ? 'off' : grant.fingerprint === s.fingerprint ? 'allowed' : 'changed';
    return { key, name: s.name, server: s, grant, state };
  });
  for (const g of grants) {
    const key = grantKey(g);
    if (appliesTo(g, repo) && !rows.some((r) => r.key === key)) rows.push({ key, name: g.name, server: undefined, grant: g, state: 'missing' });
  }
  return rows;
}

/** The grants with a server allowed as it is now (replacing any earlier grant for it), or none for it. */
export function setGrant(grants: readonly McpGrant[], server: McpServerInfo, on: boolean): McpGrant[] {
  const key = grantKey(server);
  const rest = grants.filter((g) => grantKey(g) !== key);
  if (!on) return rest;
  return [...rest, { scope: server.scope, name: server.name, ...(server.repo ? { repo: server.repo } : {}), fingerprint: server.fingerprint }];
}

/** The grants without one (a server no longer there). */
export const dropGrant = (grants: readonly McpGrant[], key: string): McpGrant[] => grants.filter((g) => grantKey(g) !== key);

/** "2 of 3 servers allowed", for the switch's summary. */
export function allowedSummary(rows: readonly McpRow[]): string {
  const there = rows.filter((r) => r.server);
  const on = there.filter((r) => r.state === 'allowed').length;
  return there.length ? `${on} of ${there.length} server${there.length === 1 ? '' : 's'} allowed` : 'No servers found';
}

/** The last part of a path, to name a repo in the picker. */
export const repoLabel = (repo: string) => repo.split('/').filter(Boolean).at(-1) ?? repo;
