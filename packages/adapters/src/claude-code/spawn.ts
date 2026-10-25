import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, writeFileSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import type { KelpieEvent } from '@kelpie/protocol';
import type { Adapter, PermissionAnswer, Run, RunExit, RunSpec } from '../types.js';
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
    // Anything its rules don't settle is asked of us (a can_use_tool control request), not refused.
    '--permission-prompt-tool', 'stdio',
    '--tools', (spec.tools ?? DEFAULT_TOOLS).join(','),
    // Only Kelpie-provided MCP servers; keeps the user's global connectors out of agents.
    '--strict-mcp-config',
  ];
  if (spec.model) args.push('--model', spec.model);
  if (spec.resume) args.push('--resume', spec.resume);
  if (spec.allowedTools?.length) args.push('--allowedTools', ...spec.allowedTools);
  if (spec.disallowedTools?.length) args.push('--disallowedTools', ...spec.disallowedTools);
  if (spec.addDirs?.length) args.push('--add-dir', ...spec.addDirs);
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
  /** Buffered until read; ended after `process.exited`. */
  private readonly stream = new Readable({ objectMode: true, read() {} });
  readonly events: AsyncIterable<KelpieEvent> = this.stream;
  readonly done: Promise<RunExit>;

  private readonly parser: ClaudeCodeParser;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly raw: WriteStream;
  private readonly controls = new Map<string, (res: Obj) => void>();
  private rawLines = 0;
  private killedByInterrupt = false;
  private stderrTail = '';
  private exit: RunExit | undefined;
  private ended = false;
  private stopping = false;
  private resolveDone!: (e: RunExit) => void;

  constructor(spec: RunSpec) {
    this.runId = spec.runId ?? randomUUID();
    this.runDir = spec.runDir ?? join(homedir(), '.kelpie', 'runs', this.runId);
    this.parser = new ClaudeCodeParser({ runId: this.runId, ...(spec.resume && spec.todos ? { todos: spec.todos } : {}) });
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
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    const linesDone = once(lines, 'close');
    lines.on('line', (line) => line.trim() && this.onLine(line));
    this.child.stderr.on('data', (chunk: string) => (this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL)));
    this.child.on('error', (err) => this.finish({ code: null, signal: null }, err.message));
    // Exit is reported only after the last stdout line has been read.
    this.child.on('close', (code, signal) => void linesDone.then(() => this.finish({ code, signal })));

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
    this.parser.noteSent().forEach((ev) => this.emit(ev));
    // The CLI replays the turn on stdout once it takes it in; that becomes the user `message` event.
    this.child.stdin.write(userTurn(text));
  }

  answer(requestId: string, answer: PermissionAnswer): boolean {
    const input = this.parser.permissionInput(requestId);
    if (!input || this.exit || this.stopping) return false;
    const response = answer.allow
      ? { behavior: 'allow', updatedInput: input, ...(answer.rules?.length ? { updatedPermissions: [{ type: 'addRules', rules: answer.rules.map(ruleParts), behavior: 'allow', destination: 'session' }] } : {}) }
      : { behavior: 'deny', message: answer.message };
    this.child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n');
    this.parser
      .noteAnswered(requestId, { decision: answer.allow ? 'allow' : 'deny', by: answer.by, ...(answer.allow ? {} : { message: answer.message }) })
      .forEach((ev) => this.emit(ev));
    return true;
  }

  async setMode(mode: string): Promise<boolean> {
    if (this.exit || this.stopping) return false;
    const res = await this.control({ subtype: 'set_permission_mode', mode });
    return res?.subtype === 'success';
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
      this.emit(this.parser.emit('other', { type: 'non-json', raw: line }, { rawLine }));
      return;
    }

    if (o.type === 'control_response') {
      const res = o.response ?? {};
      this.controls.get(res.request_id)?.(res);
      this.controls.delete(res.request_id);
    } else if (o.type === 'control_request' && o.request?.subtype !== 'can_use_tool') {
      // Permission requests become events and wait for an answer. We register no hook callbacks, so
      // nothing else should ask; refuse rather than hang the CLI.
      this.child.stdin.write(
        JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: o.request_id, error: 'unsupported by kelpie' } }) + '\n',
      );
    }

    for (const ev of this.parser.parse(o, rawLine)) this.emit(ev);
  }

  private finish(exit: RunExit, error?: string): void {
    if (this.exit) return;
    this.exit = exit;
    for (const resolve of this.controls.values()) resolve({ subtype: 'error', error: 'process exited' });
    this.controls.clear();
    if (this.parser.busy) {
      this.emit(
        this.killedByInterrupt
          ? this.parser.emit('turn.ended', { status: 'interrupted', error: 'harness did not answer the interrupt; process killed' })
          : this.parser.emit('turn.ended', { status: 'failed', error: error ?? 'harness process exited mid-turn' }),
      );
    }
    this.parser.noteExited().forEach((ev) => this.emit(ev));
    const stderrTail = error ? `${this.stderrTail}${error}` : this.stderrTail;
    this.emit(this.parser.emit('process.exited', { ...exit, stderrTail }));
    this.ended = true;
    this.stream.push(null);
    this.raw.end();
    this.resolveDone(exit);
  }

  /** Queues an event for the consumer; nothing is added once the run has finished. */
  private emit(ev: KelpieEvent): void {
    if (!this.ended) this.stream.push(ev);
  }

  private exitWithin(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms)));
    return Promise.race([this.done.then(() => true), timeout]).finally(() => clearTimeout(timer));
  }
}

/** A permission rule string, `Bash(pnpm install)` or `WebSearch`, as the CLI's rule object. */
function ruleParts(rule: string): { toolName: string; ruleContent?: string } {
  const m = /^([^(]+)\((.*)\)$/s.exec(rule);
  return m ? { toolName: m[1]!, ruleContent: m[2]! } : { toolName: rule };
}

export const claudeCode: Adapter = {
  harness: 'claude-code',
  modes: ['auto', 'acceptEdits', 'plan'],
  start: (spec) => new ClaudeCodeRun(spec),
};
