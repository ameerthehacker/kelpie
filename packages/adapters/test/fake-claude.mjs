#!/usr/bin/env node
// Stand-in for `claude -p` in spawn tests. On the first stdin user turn it
// prints the fixture named by FAKE_FIXTURE (which already contains the
// replays of any later turns). With FAKE_HANG=1 it starts the turn and never
// finishes it, and ignores interrupts (a wedged CLI).
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const lines = readFileSync(process.env.FAKE_FIXTURE, 'utf8').split('\n').filter(Boolean);
const hang = process.env.FAKE_HANG === '1';
let printed = false;
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');

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
