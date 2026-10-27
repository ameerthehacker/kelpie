import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '@kelpie/store';
import { blockedReason, createApp, mcpToolPrefix, McpServers, Orchestrator, SessionManager } from '../src/index.js';

const FAKE = join(import.meta.dirname, 'fake-claude-mcp.mjs');
const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const jsonLines = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const SECRETS = ['ghp_SECRET_TOKEN', 'Bearer sk-SECRET', 's3cret-env', 'token=QUERYSECRET', 'mcpsrv_SECRETID', '--api-key=ARGSECRET'];

/** A repo with a `.mcp.json`, and a ~/.claude.json with user and local servers, every one carrying secrets. */
function fixture() {
  const home = tmp('kelpie-mcp-home-');
  const repo = tmp('kelpie-mcp-repo-');
  mkdirSync(join(repo, '.git'));
  const claudeJson = join(home, '.claude.json');
  writeFileSync(
    claudeJson,
    JSON.stringify({
      mcpServers: {
        github: { type: 'http', url: 'https://api.github.example/mcp?token=QUERYSECRET', headers: { Authorization: 'Bearer sk-SECRET' } },
        notes: { command: 'npx', args: ['notes-mcp', '--api-key=ARGSECRET'], env: { NOTES_TOKEN: 's3cret-env' } },
        kelpie: { command: 'evil' },
      },
      projects: { [repo]: { mcpServers: { db: { command: 'db-mcp', env: { PASSWORD: 'ghp_SECRET_TOKEN' } } } } },
    }),
  );
  writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { repoTool: { command: 'node', args: ['tool.js'] }, notes: { command: 'project-notes' } } }));
  const argsFile = join(home, 'args.jsonl');
  const status = [
    { name: 'claude.ai Claude Docs', status: 'pending', scope: 'claudeai', config: { type: 'claudeai-proxy', url: 'https://api.anthropic.com/v1/pages/mcp', id: 'mcpsrv_SECRETID' }, tools: [] },
    { name: 'github', status: 'needs-auth', scope: 'user', config: { type: 'http', url: 'https://api.github.example/mcp?token=QUERYSECRET' } },
    { name: 'db', status: 'failed', scope: 'local', config: { type: 'stdio', command: 'db-mcp' } },
  ];
  const mcp = new McpServers({ claudeJson, bin: FAKE, timeoutMs: 5000, env: { FAKE_MCP_STATUS: JSON.stringify(status), FAKE_MCP_ARGS_FILE: argsFile } });
  return { home, repo, claudeJson, argsFile, mcp };
}

describe("the person's MCP servers", () => {
  it('lists name, type, scope and status only: never a command, URL, env, header or id', async () => {
    const { repo, mcp } = fixture();
    const list = await mcp.list(repo);
    expect(list.servers).toEqual([
      { name: 'claude.ai Claude Docs', type: 'connector', scope: 'claudeai', status: 'connected' },
      { name: 'github', type: 'http', scope: 'user', status: 'needs-auth' },
      { name: 'kelpie', type: 'stdio', scope: 'user', status: 'unchecked', blocked: expect.stringContaining('Kelpie') },
      // The project's `notes` hides the user one of that name, as in Claude Code.
      { name: 'notes', type: 'stdio', scope: 'project', status: 'unchecked' },
      { name: 'repoTool', type: 'stdio', scope: 'project', status: 'unchecked' },
      { name: 'db', type: 'stdio', scope: 'local', status: 'failed' },
    ]);
    expect(list.checkedAt).toEqual(expect.any(String));
    const json = JSON.stringify(list);
    for (const secret of SECRETS) expect(json).not.toContain(secret.split('=').at(-1));
    for (const leak of ['npx', 'db-mcp', 'api.github', 'Authorization', 'NOTES_TOKEN', 'url', 'command', 'env', 'headers']) expect(json).not.toContain(leak);
  });

  it("asks Claude Code with the repo's own servers turned off, and keeps its answer until refreshed", async () => {
    const { repo, argsFile, mcp } = fixture();
    await mcp.list(repo);
    await mcp.list(repo);
    const [run] = jsonLines<{ args: string[]; cwd: string }>(argsFile);
    expect(jsonLines(argsFile)).toHaveLength(1);
    expect(run!.cwd).toBe(repo);
    expect(run!.args).not.toContain('--strict-mcp-config');
    const settings = JSON.parse(run!.args[run!.args.indexOf('--settings') + 1]!);
    expect(settings).toEqual({ enableAllProjectMcpServers: false, disabledMcpjsonServers: expect.arrayContaining(['repoTool', 'notes']) });
    await mcp.list(repo, true);
    expect(jsonLines(argsFile)).toHaveLength(2);
  });

  it('still lists the config files when Claude Code does not answer', async () => {
    const { repo, claudeJson } = fixture();
    const mcp = new McpServers({ claudeJson, bin: FAKE, timeoutMs: 300, env: { FAKE_MCP_SILENT: '1' } });
    const list = await mcp.list(repo);
    expect(list.error).toMatch(/did not answer/);
    expect(list.servers.map((s) => s.name)).toEqual(['github', 'kelpie', 'notes', 'repoTool', 'db']);
    const missing = new McpServers({ claudeJson, bin: join(repo, 'no-such-claude') });
    expect((await missing.list(repo)).error).toMatch(/could not run/);
  });

  it('gives agents only the allowed servers, as configured, and never one named like Kelpie’s own', async () => {
    const { repo, mcp, argsFile } = fixture();
    // Only config-file servers allowed: no need to ask Claude Code.
    await mcp.ensure(repo, ['github', 'db']);
    expect(jsonLines(argsFile)).toHaveLength(0);
    expect(mcp.forAgents(repo, ['github', 'db', 'kelpie', 'gone'])).toEqual({
      servers: {
        github: { type: 'http', url: 'https://api.github.example/mcp?token=QUERYSECRET', headers: { Authorization: 'Bearer sk-SECRET' } },
        db: { command: 'db-mcp', env: { PASSWORD: 'ghp_SECRET_TOKEN' } },
      },
      blocked: ['kelpie'],
    });
    // A connector's entry comes from Claude Code: asked once, then known.
    expect(mcp.forAgents(repo, ['claude.ai Claude Docs']).servers).toEqual({});
    await mcp.ensure(repo, ['claude.ai Claude Docs']);
    await mcp.ensure(repo, ['claude.ai Claude Docs']);
    expect(jsonLines(argsFile)).toHaveLength(1);
    expect(mcp.forAgents(repo, ['claude.ai Claude Docs']).servers).toEqual({
      'claude.ai Claude Docs': { type: 'claudeai-proxy', url: 'https://api.anthropic.com/v1/pages/mcp', id: 'mcpsrv_SECRETID' },
    });
  });

  it('names servers in tool names as Claude Code does, and reserves Kelpie’s own names', () => {
    expect(mcpToolPrefix('claude.ai Claude Docs')).toBe('claude_ai_Claude_Docs');
    expect(mcpToolPrefix('my-server_2')).toBe('my-server_2');
    expect(blockedReason('kelpie')).toMatch(/Kelpie/);
    expect(blockedReason('claude-in-chrome')).toMatch(/browser/);
    expect(blockedReason('kelpie2')).toBeUndefined();
  });

  it('serves the list at /api/mcp/servers, refreshed on demand', async () => {
    const { repo, mcp, argsFile } = fixture();
    const store = openStore(':memory:');
    const orch = new Orchestrator({ store, mcpUrl: 'http://127.0.0.1:7317/mcp' });
    const sessions = new SessionManager({ store, defaultCwd: repo, hooks: orch });
    orch.attach(sessions);
    const app = createApp(sessions, { orchestrator: orch, mcpServers: mcp });
    const get = async (q = '') => (await app.request('/api/mcp/servers' + q, { headers: { host: '127.0.0.1:7317' } })).json() as Promise<{ cwd: string; servers: { name: string }[] }>;
    const body = await get();
    expect(body.cwd).toBe(repo);
    expect(body.servers.map((s) => s.name)).toContain('claude.ai Claude Docs');
    for (const secret of SECRETS) expect(JSON.stringify(body)).not.toContain(secret.split('=').at(-1));
    await get();
    expect(jsonLines(argsFile)).toHaveLength(1);
    await get('?refresh=1');
    expect(jsonLines(argsFile)).toHaveLength(2);
  });
});
