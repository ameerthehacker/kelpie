import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, writeFileSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { KelpieEvent } from '@kelpie/protocol';
import type { Adapter, Run, RunExit, RunSpec } from '../types.js';
import { LineSplitter } from '../util/jsonl.js';
import { AsyncQueue } from '../util/queue.js';
import { ClaudeCodeParser } from './parse.js';

type Obj = Record<string, any>;

/**
 * Tools a Kelpie agent gets by default. Spelled out because `--tools default`
 * cannot be combined with extras, and the default set lacks the
 * TaskCreate/TaskUpdate todo tools that feed the UI's todo list.
 */
export const DEFAULT_TOOLS = [
  'Task',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read',
  'Write',
  'WebFetch',
  'WebSearch',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
];

const STDERR_TAIL = 8 * 1024;
const CONTROL_TIMEOUT_MS = 5000;

export function claudeArgs(spec: RunSpec): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    // Echoes each stdin turn as the CLI takes it in: our record of sent turns, and how queued turns are tracked.
    '--replay-user-messages',
    '--permission-mode', spec.permissionMode ?? 'acceptEdits',
    '--tools', (spec.tools ?? DEFAULT_TOOLS).join(','),
    // Only Kelpie-provided MCP servers; keeps the user's global connectors out of agents.
    '--strict-mcp-config',
  ];
  if (spec.model) args.push('--model', spec.model);
  if (spec.resume) args.push('--resume', spec.resume);
  if (spec.allowedTools?.length) args.push('--allowedTools', ...spec.allowedTools);
  if (spec.disallowedTools?.length) args.push('--disallowedTools', ...spec.disallowedTools);
  if (spec.appendSystemPrompt) args.push('--append-system-prompt', spec.appendSystemPrompt);
  if (spec.mcpConfig?.length) args.push('--mcp-config', ...spec.mcpConfig);
  if (spec.extraArgs?.length) args.push(...spec.extraArgs);
  return args;
}

export const userTurn = (text: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';

class ClaudeCodeRun implements Run {
  readonly harness = 'claude-code' as const;
  readonly runId: string;
  readonly runDir: string;
  readonly events = new AsyncQueue<KelpieEvent>();
  readonly done: Promise<RunExit>;

  private readonly parser: ClaudeCodeParser;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly raw: WriteStream;
  private readonly splitter = new LineSplitter();
  private readonly controls = new Map<string, (res: Obj) => void>();
  private rawLines = 0;
  private killedByInterrupt = false;
  private stderrTail = '';
  private exit: RunExit | undefined;
  private stopping = false;
  private resolveDone!: (e: RunExit) => void;

  constructor(spec: RunSpec) {
    this.runId = spec.runId ?? randomUUID();
    this.runDir = spec.runDir ?? join(homedir(), '.kelpie', 'runs', this.runId);
    this.parser = new ClaudeCodeParser({ runId: this.runId });
    this.done = new Promise((r) => (this.resolveDone = r));

    const bin = spec.bin ?? 'claude';
    const args = claudeArgs(spec);
    // rawLine pointers index raw.jsonl from line 1, so a directory holds exactly one run.
    if (existsSync(join(this.runDir, 'raw.jsonl'))) {
      throw new Error(`${this.runDir} already holds a run; start a new runId (continue a session with \`resume\`)`);
    }
    mkdirSync(this.runDir, { recursive: true });
    writeFileSync(
      join(this.runDir, 'run.json'),
      JSON.stringify({ runId: this.runId, harness: this.harness, cwd: spec.cwd, bin, args, startedAt: new Date().toISOString() }, null, 2),
    );
    this.raw = createWriteStream(join(this.runDir, 'raw.jsonl'), { flags: 'a' });

    this.child = spawn(bin, args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => {}); // EPIPE after exit is reported via 'close'
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.splitter.push(chunk).forEach((l) => this.onLine(l)));
    this.child.stderr.on('data', (chunk: string) => (this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL)));
    this.child.on('error', (err) => this.finish({ code: null, signal: null }, err.message));
    this.child.on('close', (code, signal) => {
      this.splitter.flush().forEach((l) => this.onLine(l));
      this.finish({ code, signal });
    });

    if (spec.prompt) this.send(spec.prompt);
  }

  get harnessSessionId(): string | undefined {
    return this.parser.harnessSessionId;
  }

  get busy(): boolean {
    return this.parser.busy;
  }

  get exited(): boolean {
    return this.exit !== undefined;
  }

  send(text: string): void {
    if (this.exit || this.stopping) throw new Error(`run ${this.runId} is ${this.exit ? 'exited' : 'stopping'}`);
    this.parser.noteSent().forEach((ev) => this.events.push(ev));
    // The CLI replays the turn on stdout once it takes it in; that becomes the user `message` event.
    this.child.stdin.write(userTurn(text));
  }

  async interrupt(): Promise<void> {
    if (this.exit || !this.busy) return;
    const res = await this.control({ subtype: 'interrupt' });
    // An error answer usually means the turn ended meanwhile; leave the session alone.
    // No answer at all while still mid-turn means the CLI is wedged: end it, losing the session process.
    if (res === undefined && this.busy && !this.exit) {
      this.killedByInterrupt = true;
      this.child.kill('SIGINT');
    }
  }

  async stop(): Promise<RunExit> {
    if (this.exit) return this.exit;
    this.stopping = true;
    this.child.stdin.end();
    if (await this.exitWithin(1500)) return this.done;
    this.child.kill('SIGTERM');
    if (await this.exitWithin(5000)) return this.done;
    this.child.kill('SIGKILL');
    return this.done;
  }

  /** Sends a control request; resolves with the response, or undefined on timeout. */
  private control(request: Obj): Promise<Obj | undefined> {
    const id = `kelpie-${randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.controls.delete(id);
        resolve(undefined);
      }, CONTROL_TIMEOUT_MS);
      this.controls.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      this.child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
    });
  }

  private onLine(line: string): void {
    this.raw.write(line + '\n');
    const rawLine = ++this.rawLines;
    let o: Obj;
    try {
      o = JSON.parse(line);
    } catch {
      this.events.push(this.parser.emit('other', { type: 'non-json', raw: line }, { rawLine }));
      return;
    }

    if (o.type === 'control_response') {
      const res = o.response ?? {};
      this.controls.get(res.request_id)?.(res);
      this.controls.delete(res.request_id);
    } else if (o.type === 'control_request') {
      // We register no permission or hook callbacks, so nothing should ask; refuse rather than hang the CLI.
      this.child.stdin.write(
        JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: o.request_id, error: 'unsupported by kelpie' } }) + '\n',
      );
    }

    for (const ev of this.parser.parse(o, rawLine)) this.events.push(ev);
  }

  private finish(exit: RunExit, error?: string): void {
    if (this.exit) return;
    this.exit = exit;
    for (const resolve of this.controls.values()) resolve({ subtype: 'error', error: 'process exited' });
    this.controls.clear();
    if (this.parser.busy) {
      this.events.push(
        this.killedByInterrupt
          ? this.parser.emit('turn.ended', { status: 'interrupted', error: 'harness did not answer the interrupt; process killed' })
          : this.parser.emit('turn.ended', { status: 'failed', error: error ?? 'harness process exited mid-turn' }),
      );
    }
    this.parser.noteExited().forEach((ev) => this.events.push(ev));
    const stderrTail = error ? `${this.stderrTail}${error}` : this.stderrTail;
    this.events.push(this.parser.emit('process.exited', { ...exit, stderrTail }));
    this.events.close();
    this.raw.end();
    this.resolveDone(exit);
  }

  private exitWithin(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms)));
    return Promise.race([this.done.then(() => true), timeout]).finally(() => clearTimeout(timer));
  }
}

export const claudeCode: Adapter = {
  harness: 'claude-code',
  start: (spec) => new ClaudeCodeRun(spec),
};
