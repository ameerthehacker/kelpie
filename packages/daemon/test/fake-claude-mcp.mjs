#!/usr/bin/env node
// Stand-in for `claude -p` answering the mcp_status control request, as Claude Code 2.1.308 does: the
// first answer is an empty list (its config not loaded yet), then FAKE_MCP_STATUS (a JSON array of
// servers; any still `pending` turn `connected` on the next ask). FAKE_MCP_ARGS_FILE gets the argv;
// FAKE_MCP_SILENT=1 never answers. FAKE_MCP_START=<.claude.json> starts that file's user servers in its
// own cwd, as Claude Code does (and leaves them be).
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.env.FAKE_MCP_ARGS_FILE) appendFileSync(process.env.FAKE_MCP_ARGS_FILE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\n');
if (process.env.FAKE_MCP_START) {
  for (const c of Object.values(JSON.parse(readFileSync(process.env.FAKE_MCP_START, 'utf8')).mcpServers ?? {})) {
    if (c.command) spawn(c.command, c.args ?? [], { stdio: 'ignore', env: { ...process.env, ...c.env } }).on('error', () => {});
  }
}
let servers = JSON.parse(process.env.FAKE_MCP_STATUS ?? '[]');
let asked = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  const o = JSON.parse(line);
  if (o.type !== 'control_request' || o.request?.subtype !== 'mcp_status' || process.env.FAKE_MCP_SILENT === '1') return;
  const answer = asked++ === 0 ? [] : servers;
  if (asked > 1) servers = servers.map((s) => (s.status === 'pending' ? { ...s, status: 'connected' } : s));
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: { mcpServers: answer } } }) + '\n');
});
process.stdin.on('end', () => process.exit(0));
