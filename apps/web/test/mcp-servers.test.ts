import { describe, expect, it } from 'vitest';
import { ruleLabel } from '../src/lib/approvals.js';
import { allowedSummary, mcpRows, toggleAllow, type McpServerInfo } from '../src/lib/mcp-servers.js';
import { withPatch, type SettingsWithLimits } from '../src/lib/settings.js';

const servers: McpServerInfo[] = [
  { name: 'claude.ai Claude Docs', type: 'connector', scope: 'claudeai', status: 'connected' },
  { name: 'github', type: 'http', scope: 'user', status: 'needs-auth' },
  { name: 'kelpie', type: 'stdio', scope: 'user', status: 'unchecked', blocked: 'Kelpie’s own server…' },
];

describe('MCP servers in Settings', () => {
  it('ticks the allowed servers, never one named like Kelpie’s, and keeps allowed ones that went away so they can be turned off', () => {
    const rows = mcpRows(servers, ['github', 'kelpie', 'gone']);
    expect(rows.map((r) => [r.name, r.allowed, r.selectable, !!r.server])).toEqual([
      ['claude.ai Claude Docs', false, true, true],
      ['github', true, true, true],
      ['kelpie', false, false, true],
      ['gone', true, true, false],
    ]);
    expect(allowedSummary(rows)).toBe('1 of 3 servers allowed');
    expect(allowedSummary(mcpRows([], []))).toBe('No servers found');
    expect(allowedSummary(mcpRows(servers.slice(0, 1), ['claude.ai Claude Docs']))).toBe('1 of 1 server allowed');
  });

  it('turns one server on or off in the allowlist, in the list’s order, each once', () => {
    const order = servers.map((s) => s.name);
    expect(toggleAllow(['github'], 'claude.ai Claude Docs', true, order)).toEqual(['claude.ai Claude Docs', 'github']);
    expect(toggleAllow(['github'], 'github', true, order)).toEqual(['github']);
    expect(toggleAllow(['github', 'gone'], 'github', false, order)).toEqual(['gone']);
    expect(toggleAllow([], 'x', false)).toEqual([]);
  });

  it('shows a change to the switch or the list at once, and null as its default', () => {
    const s: SettingsWithLimits = { maxAgents: 6, autoResume: false, useUserMcp: true, mcpAllow: ['github'], limits: { maxAgents: { min: 1, max: 16, default: 5 } } };
    expect(withPatch(s, { useUserMcp: false })).toMatchObject({ useUserMcp: false, mcpAllow: ['github'] });
    expect(withPatch(s, { mcpAllow: ['a', 'b'] }).mcpAllow).toEqual(['a', 'b']);
    expect(withPatch(s, { useUserMcp: null, mcpAllow: null, maxAgents: null, autoResume: null })).toMatchObject({ useUserMcp: false, mcpAllow: [], maxAgents: 5, autoResume: true });
  });

  it('says what remembering an MCP tool allows: that one tool of its server', () => {
    expect(ruleLabel('mcp__claude_ai_Claude_Docs__guide')).toBe('every guide call to claude_ai_Claude_Docs');
    expect(ruleLabel('Bash(npm run:*)')).toBe('Bash(npm run:*)');
    expect(ruleLabel('mcp__github')).toBe('mcp__github');
  });
});
