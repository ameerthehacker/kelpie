/**
 * Dev runner: starts a harness session and prints its KEF stream live.
 *
 *   pnpm kelpie:run --cwd <dir> [--model m] [--resume id] [--json] [--verbose] ["prompt"]
 *
 * Type a line to send another turn (sent immediately; the harness queues it
 * if busy). Ctrl-C interrupts the running turn, a second Ctrl-C (or Ctrl-C
 * while idle) ends the session.
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs, styleText } from 'node:util';
import type { EventData, KelpieEvent } from '@kelpie/protocol';
import { claudeCode } from '@kelpie/adapters';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cwd: { type: 'string', default: process.cwd() },
    model: { type: 'string' },
    resume: { type: 'string' },
    'permission-mode': { type: 'string' },
    json: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
  },
});

type Color = Parameters<typeof styleText>[0];
const LABEL_COLOR: Record<string, Color> = {
  read: 'gray',
  search: 'gray',
  edit: 'blue',
  bash: 'magenta',
  web: 'cyan',
  task: 'cyan',
  mcp: 'cyan',
  todo: 'white',
  think: 'gray',
  done: 'green',
  fail: 'red',
  ask: 'yellow',
};

const time = (ts: string) => new Date(ts).toTimeString().slice(0, 8);
const todoMark = { completed: '✓', in_progress: '›', pending: '·' } as const;

function line(ev: KelpieEvent, label: string, text: string): void {
  const indent = ev.parentCallId ? styleText('gray', '│ ') : '';
  console.log(`${styleText('gray', time(ev.ts))}  ${indent}${styleText(LABEL_COLOR[label] ?? 'white', label.padEnd(6))} ${text}`);
}

let lastUsage: EventData<'usage'> | undefined;
// Edits print once their outcome is known, with line counts when the parser has them.
const pendingEdits = new Map<string, string>();
// A successful edit waiting for the file.changed that directly follows it, if any (NotebookEdit has none).
let heldEdit: { ev: KelpieEvent; callId: string; title: string } | undefined;

function flushHeldEdit(next?: KelpieEvent): void {
  if (!heldEdit) return;
  if (next?.kind === 'file.changed' && next.data.callId === heldEdit.callId) return;
  line(heldEdit.ev, 'edit', heldEdit.title);
  heldEdit = undefined;
}

function render(ev: KelpieEvent): void {
  if (opts.json) {
    console.log(JSON.stringify(ev));
    return;
  }
  flushHeldEdit(ev);
  switch (ev.kind) {
    case 'session.started':
      console.log(styleText('gray', `── session ${ev.data.harnessSessionId} · ${ev.data.model} · ${ev.data.cwd}`));
      break;
    case 'message':
      if (ev.data.role === 'user') console.log(styleText('bold', `\n› ${ev.data.text}`));
      else console.log(`\n${ev.parentCallId ? styleText('gray', ev.data.text) : ev.data.text}\n`);
      break;
    case 'thinking':
      if (opts.verbose) line(ev, 'think', ev.data.redacted ? '…' : ev.data.text);
      break;
    case 'tool.started':
      if (ev.data.category === 'todo') break;
      if (ev.data.category === 'edit') pendingEdits.set(ev.data.callId, ev.data.title);
      else line(ev, ev.data.category, ev.data.title);
      break;
    case 'tool.finished': {
      const editTitle = pendingEdits.get(ev.data.callId);
      pendingEdits.delete(ev.data.callId);
      if (!ev.data.ok) line(ev, 'fail', `${editTitle ?? ev.data.name}: ${ev.data.output.split('\n', 1)[0]}`);
      else if (editTitle !== undefined) heldEdit = { ev, callId: ev.data.callId, title: editTitle };
      break;
    }
    case 'file.changed': {
      const title = heldEdit?.callId === ev.data.callId ? heldEdit.title : ev.data.path;
      heldEdit = undefined;
      line(ev, 'edit', `${title} ${styleText('green', `+${ev.data.added}`)} ${styleText('red', `−${ev.data.removed}`)}`);
      break;
    }
    case 'todos': {
      const marks = ev.data.items.map((t) => todoMark[t.status]).join(' ');
      const active = ev.data.items.find((t) => t.status === 'in_progress');
      line(ev, 'todo', `[${marks}]${active ? ` ${active.activeText ?? active.text}` : ''}`);
      break;
    }
    case 'usage':
      lastUsage = ev.data;
      break;
    case 'turn.ended': {
      const d = ev.data;
      const cost = lastUsage?.costUsd != null ? `$${lastUsage.costUsd.toFixed(4)}` : '';
      const meta = [cost, d.numTurns != null && `${d.numTurns} turns`, d.durationMs != null && `${(d.durationMs / 1000).toFixed(1)}s`].filter(Boolean).join(' · ');
      if (d.status === 'completed') line(ev, 'done', meta);
      else line(ev, d.status === 'interrupted' ? 'ask' : 'fail', `${d.status}${d.error ? `: ${d.error}` : ''} ${meta}`);
      break;
    }
    case 'rate_limit':
      if (ev.data.status !== 'allowed' || opts.verbose) line(ev, 'ask', `rate limit ${ev.data.status} (${ev.data.window ?? '?'}, resets ${ev.data.resetsAt ?? '?'})`);
      break;
    case 'process.exited':
      console.log(styleText('gray', `── exited code=${ev.data.code} signal=${ev.data.signal}`));
      if (ev.data.code && ev.data.stderrTail) console.log(styleText('red', ev.data.stderrTail.trim()));
      break;
    case 'other':
      if (opts.verbose) line(ev, 'other', ev.data.type);
      break;
  }
}

// Run logs go where the dev daemon keeps its data (packages/daemon/src/main.ts), not an installed Kelpie's.
const home = process.env.KELPIE_HOME || join(homedir(), '.kelpie-dev');
const runId = randomUUID();
const run = claudeCode.start({
  cwd: resolve(opts.cwd),
  runId,
  runDir: join(home, 'runs', runId),
  ...(positionals.length ? { prompt: positionals.join(' ') } : {}),
  ...(opts.model ? { model: opts.model } : {}),
  ...(opts.resume ? { resume: opts.resume } : {}),
  ...(opts['permission-mode'] ? { permissionMode: opts['permission-mode'] } : {}),
  allowedTools: ['Bash'],
});
console.log(styleText('gray', `── run ${run.runId} · raw: ${run.runDir}/raw.jsonl`));

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' });
let lastSigint = 0;
rl.on('line', (text) => {
  const t = text.trim();
  if (!t) return;
  if (t === '/exit') {
    void run.stop();
    return;
  }
  try {
    run.send(t);
  } catch (err) {
    console.log(styleText('red', `── not sent: ${(err as Error).message}`));
  }
});
rl.on('SIGINT', () => {
  const now = Date.now();
  if (run.busy && now - lastSigint > 2000) {
    lastSigint = now;
    console.log(styleText('yellow', '\n── interrupting (Ctrl-C again to quit)'));
    void run.interrupt();
  } else {
    void run.stop();
  }
});
rl.on('close', () => void run.stop());

if (!positionals.length) rl.prompt();
for await (const ev of run.events) {
  render(ev);
  // In-stream, so it is ordered with the events around it (unlike reading run.busy here).
  if (ev.kind === 'activity' && !ev.data.busy) rl.prompt();
}
flushHeldEdit();
rl.close();
if (run.harnessSessionId) console.log(styleText('gray', `── resume with: --resume ${run.harnessSessionId}`));
