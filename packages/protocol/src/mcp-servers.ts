import { z } from 'zod';

/**
 * The person's own MCP servers, as `GET /api/mcp/servers` lists them for Settings: never a
 * server's command, URL, env or headers, which can hold secrets.
 */

/**
 * Where a server is configured: ~/.claude.json (`user`, or `local` under a project's entry), a
 * repo's `.mcp.json` (`project`), or the person's claude.ai account (`claudeai`, a connector).
 */
export const McpScope = z.enum(['user', 'project', 'local', 'claudeai'], { error: 'scope must be user, project, local or claudeai' });
export type McpScope = z.infer<typeof McpScope>;

/** Scopes whose servers belong to one repo: allowing one allows it in that repo only. */
export const REPO_SCOPES: readonly McpScope[] = ['project', 'local'];

/**
 * Whether Claude Code could reach it when Kelpie last looked. `unchecked`: not looked at, like a
 * repo's own server, which Kelpie does not start just to look (a cloned repo's `.mcp.json` can run anything).
 */
export type McpStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'unchecked';

/** An MCP server's name as Claude Code has it: `github`, `claude.ai Claude Docs`. */
export const McpServerName = z
  .string({ error: 'a server name must be text' })
  .min(1, { error: 'an MCP server name cannot be empty' })
  .max(200, { error: 'an MCP server name can be at most 200 characters' });

/**
 * One server the person allowed, by what it is, not just its name: where it is configured (and
 * for a repo's own, which repo), and a fingerprint of its entry (everything that decides what it
 * runs or reaches: command, arguments, URL, env, headers helper, OAuth). A server of the same name
 * elsewhere, or this one once its entry changes, is not allowed by it.
 */
export const McpGrant = z
  .object({
    scope: McpScope,
    name: McpServerName,
    /** The directory a project or local server is configured for; none for user servers and connectors. */
    repo: z.string({ error: 'repo must be a directory' }).min(1).max(4096).optional(),
    fingerprint: z.string({ error: 'fingerprint must be text' }).regex(/^[0-9a-f]{16}$/, { error: 'fingerprint must be 16 hex digits, as the server list gives it' }),
  })
  .strict()
  .refine((g) => REPO_SCOPES.includes(g.scope) === (g.repo !== undefined), { error: 'repo is required for project and local servers, and only for them' });
export type McpGrant = z.infer<typeof McpGrant>;

/** What a grant is for, whatever its fingerprint: one server in one place. */
export const grantKey = (g: Pick<McpGrant, 'scope' | 'name' | 'repo'>): string => JSON.stringify([g.scope, g.repo ?? '', g.name]);

/** Grants are the same server if they have the same key and fingerprint. */
export const sameGrant = (a: McpGrant, b: McpGrant): boolean => grantKey(a) === grantKey(b) && a.fingerprint === b.fingerprint;

export interface McpServerInfo {
  name: string;
  /** stdio, http, sse, ws, or `connector` for a claude.ai one. */
  type: string;
  scope: McpScope;
  /** For project and local servers: the directory they are configured for. */
  repo?: string;
  /** A hash of what it runs or reaches (see `McpGrant`): changes when its command, URL, env, headers helper or the like do. */
  fingerprint: string;
  /**
   * For a repo's own server (project): what allowing it would run or reach, a line each (its
   * command line or URL, its headers helper, the names of its env and headers). Never shown for the
   * person's own servers, whose entries can hold their secrets.
   */
  runs?: string[];
  status: McpStatus;
  /** Why agents can't have it, if they can't (its name could pass for another server's tools). */
  blocked?: string;
}

export interface McpServerList {
  /** The repo whose project and local servers these are. */
  repo: string;
  /** The repos the person can look at: Kelpie's own and each round-up's. */
  repos: string[];
  servers: McpServerInfo[];
  /** When Claude Code was last asked (ISO); undefined if it never was, for this repo. */
  checkedAt?: string;
  /** Why asking Claude Code failed, if it did: the servers in the config files are listed anyway. */
  error?: string;
}
