#!/usr/bin/env node
// Stand-in for `claude -p` answering the initialize control request with its slash commands, as Claude
// Code 2.1.308 does: FAKE_COMMANDS (a JSON array). FAKE_COMMANDS_ARGS_FILE gets the argv and cwd, one
// line a start; FAKE_COMMANDS_SILENT=1 never answers.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.env.FAKE_COMMANDS_ARGS_FILE) appendFileSync(process.env.FAKE_COMMANDS_ARGS_FILE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const o = JSON.parse(line);
  if (o.type !== 'control_request' || o.request?.subtype !== 'initialize' || process.env.FAKE_COMMANDS_SILENT === '1') return;
  const commands = JSON.parse(process.env.FAKE_COMMANDS ?? '[]');
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: { commands, agents: [], models: [] } } }) + '\n');
});
process.stdin.on('end', () => process.exit(0));
