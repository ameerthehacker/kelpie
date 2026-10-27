/**
 * The person's own MCP servers, as `GET /api/mcp/servers` lists them for Settings: never a
 * server's command, URL, env or headers, which can hold secrets.
 */

/**
 * Where a server is configured: ~/.claude.json (`user`, or `local` under a project's entry), a
 * repo's `.mcp.json` (`project`), or the person's claude.ai account (`claudeai`, a connector).
 */
export type McpScope = 'user' | 'project' | 'local' | 'claudeai';

/**
 * Whether Claude Code could reach it when Kelpie last looked. `unchecked`: not looked at, like a
 * repo's own server, which Kelpie does not start just to look (a cloned repo's `.mcp.json` can run anything).
 */
export type McpStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'unchecked';

export interface McpServerInfo {
  name: string;
  /** stdio, http, sse, ws, or `connector` for a claude.ai one. */
  type: string;
  scope: McpScope;
  status: McpStatus;
  /** Why agents can't have it, if they can't: its name is one of Kelpie's own servers'. */
  blocked?: string;
}

export interface McpServerList {
  /** The directory whose project and local servers these are. */
  cwd: string;
  servers: McpServerInfo[];
  /** When Claude Code was last asked (ISO); undefined if it never answered. */
  checkedAt?: string;
  /** Why asking Claude Code failed, if it did: the servers in the config files are listed anyway. */
  error?: string;
}
