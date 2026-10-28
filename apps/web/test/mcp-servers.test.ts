import { describe, expect, it } from 'vitest';
import { ruleLabel } from '../src/lib/approvals.js';
import { allowedSummary, dropGrant, mcpRows, repoLabel, setGrant, type McpGrant, type McpServerInfo } from '../src/lib/mcp-servers.js';
import { withPatch, type SettingsWithLimits } from '../src/lib/settings.js';

const REPO = '/work/repo';
const servers: McpServerInfo[] = [
  { name: 'claude.ai Claude Docs', type: 'connector', scope: 'claudeai', fingerprint: 'aaaaaaaaaaaaaaaa', status: 'connected' },
  { name: 'github', type: 'http', scope: 'user', fingerprint: 'bbbbbbbbbbbbbbbb', status: 'needs-auth' },
  { name: 'github', type: 'stdio', scope: 'project', repo: REPO, fingerprint: 'cccccccccccccccc', status: 'unchecked' },
  { name: 'kelpie', type: 'stdio', scope: 'user', fingerprint: 'dddddddddddddddd', status: 'unchecked', blocked: 'Kelpie’s own server…' },
];
const grant = (s: McpServerInfo, fingerprint = s.fingerprint): McpGrant => ({ scope: s.scope, name: s.name, ...(s.repo ? { repo: s.repo } : {}), fingerprint });

describe('MCP servers in Settings', () => {
  it('ticks a server only as allowed: its scope and repo, and its command or URL unchanged', () => {
    const grants = [grant(servers[1]!, 'eeeeeeeeeeeeeeee'), grant(servers[3]!), { scope: 'user', name: 'gone', fingerprint: 'ffffffffffffffff' } as McpGrant];
    const rows = mcpRows(servers, grants, REPO);
    expect(rows.map((r) => [r.name, r.server?.scope ?? r.grant?.scope, r.state])).toEqual([
      ['claude.ai Claude Docs', 'claudeai', 'off'],
      // The person's github, allowed when its URL was different.
      ['github', 'user', 'changed'],
      // The repo's own github is a server of its own: not ticked by the person's.
      ['github', 'project', 'off'],
      ['kelpie', 'user', 'blocked'],
      ['gone', 'user', 'missing'],
    ]);
    expect(allowedSummary(rows)).toBe('0 of 4 servers allowed');
    expect(allowedSummary(mcpRows(servers, [grant(servers[0]!)], REPO))).toBe('1 of 4 servers allowed');
    expect(allowedSummary(mcpRows([], [], REPO))).toBe('No servers found');
  });

  it("shows another repo's allowed servers only in that repo", () => {
    const elsewhere: McpGrant = { scope: 'project', name: 'tool', repo: '/other', fingerprint: 'ffffffffffffffff' };
    const parent: McpGrant = { scope: 'project', name: 'tool', repo: '/work', fingerprint: 'ffffffffffffffff' };
    expect(mcpRows([], [elsewhere, parent], REPO).map((r) => r.grant?.repo)).toEqual(['/work']);
    expect(mcpRows([], [elsewhere], '/other-repo')).toEqual([]);
  });

  it('allows a server as it is now, replacing an older grant for it, and turns it off', () => {
    const old = grant(servers[1]!, 'eeeeeeeeeeeeeeee');
    expect(setGrant([old], servers[1]!, true)).toEqual([grant(servers[1]!)]);
    expect(setGrant([old, grant(servers[0]!)], servers[1]!, false)).toEqual([grant(servers[0]!)]);
    expect(setGrant([], servers[2]!, true)).toEqual([{ scope: 'project', name: 'github', repo: REPO, fingerprint: 'cccccccccccccccc' }]);
    const rows = mcpRows([], [old], REPO);
    expect(dropGrant([old], rows[0]!.key)).toEqual([]);
    expect(repoLabel('/Users/me/code/kelpie')).toBe('kelpie');
  });

  it('shows a change to the switch or the list at once, and null as its default', () => {
    const s: SettingsWithLimits = { maxAgents: 6, autoResume: false, useUserMcp: true, mcpAllow: [grant(servers[1]!)], delegation: 'balanced', limits: { maxAgents: { min: 1, max: 16, default: 5 } } };
    expect(withPatch(s, { useUserMcp: false })).toMatchObject({ useUserMcp: false, mcpAllow: [grant(servers[1]!)] });
    expect(withPatch(s, { mcpAllow: [] }).mcpAllow).toEqual([]);
    expect(withPatch(s, { useUserMcp: null, mcpAllow: null, maxAgents: null, autoResume: null })).toMatchObject({ useUserMcp: false, mcpAllow: [], maxAgents: 5, autoResume: true });
  });

  it('says what remembering an MCP tool allows: that one tool of its server', () => {
    expect(ruleLabel('mcp__claude_ai_Claude_Docs__guide')).toBe('every guide call to claude_ai_Claude_Docs');
    expect(ruleLabel('Bash(npm run:*)')).toBe('Bash(npm run:*)');
    expect(ruleLabel('mcp__github')).toBe('mcp__github');
  });
});
