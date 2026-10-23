#!/usr/bin/env node
// Stand-in for `claude -p` in spawn tests. On the first stdin user turn it
// prints the fixture named by FAKE_FIXTURE (which already contains the
// replays of any later turns). With FAKE_HANG=1 it starts the turn and never
// finishes it, and ignores interrupts (a wedged CLI). FAKE_ARGS_FILE gets one
// line of JSON argv per start; FAKE_RESUME_FAIL=1 makes `--resume` fail the
// way the real CLI does for an unknown session; FAKE_EXIT_DELAY (ms) keeps it
// alive that long after stdin closes, like a slow shutdown.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const lines = readFileSync(process.env.FAKE_FIXTURE, 'utf8').split('\n').filter(Boolean);
const hang = process.env.FAKE_HANG === '1';
let printed = false;
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
const args = process.argv.slice(2);
if (process.env.FAKE_ARGS_FILE) appendFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args) + '\n');

const resume = args[args.indexOf('--resume') + 1];
if (process.env.FAKE_RESUME_FAIL === '1' && args.includes('--resume')) {
  const error = `No conversation found with session ID: ${resume}`;
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 0, num_turns: 0, session_id: resume, total_cost_usd: 0, usage: {}, errors: [error] });
  process.stderr.write(error + '\n');
  process.exit(1);
}

for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') {
    if (!hang) out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
  } else if (msg.type === 'user' && !printed) {
    printed = true;
    if (hang) {
      lines.filter((l) => !l.includes('"type":"result"')).slice(0, 3).forEach(out);
    } else {
      lines.forEach(out);
    }
  }
}

if (process.env.FAKE_EXIT_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_EXIT_DELAY)));
