import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, type WriteStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import type { Effort, KelpieEvent } from '@kelpie/protocol';
import { resetFromText, type UsageLimitStop } from '../limits.js';
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
  // Structured questions for the person; they come to us as permission requests and wait for the answers.
  'AskUserQuestion',
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
    // Only the MCP servers in --mcp-config: Kelpie's, plus those the person allowed agents (off by default).
    '--strict-mcp-config',
  ];
  if (spec.model) args.push('--model', spec.model);
  // Given on every start, a resume included, so the session keeps it whatever the person's own settings say.
  if (spec.effort) args.push('--effort', spec.effort);
  if (spec.resume) args.push('--resume', spec.resume);
  if (spec.allowedTools?.length) args.push('--allowedTools', ...spec.allowedTools);
  if (spec.disallowedTools?.length) args.push('--disallowedTools', ...spec.disallowedTools);
  // An ask rule beats allow rules and auto mode's own checks: each such call comes to us (can_use_tool).
  if (spec.askTools?.length) args.push('--settings', JSON.stringify({ permissions: { ask: spec.askTools } }));
  if (spec.addDirs?.length) args.push('--add-dir', ...spec.addDirs);
  if (spec.appendSystemPrompt) args.push('--append-system-prompt', spec.appendSystemPrompt);
  if (spec.mcpConfig?.length) args.push('--mcp-config', ...spec.mcpConfig);
  // Claude in Chrome is a built-in MCP server (mcp__claude-in-chrome__*) that --strict-mcp-config leaves alone.
  args.push(spec.browser ? '--chrome' : '--no-chrome');
  if (spec.extraArgs?.length) args.push(...spec.extraArgs);
  return args;
}

/**
 * Writes each inline MCP config (JSON, which may carry a bearer token) to a file only the person can
 * read, in a private directory of its own, so it never shows in argv (`ps`) or in run.json. Paths pass
 * through. Returns the paths and the directory to remove once the process has exited.
 */
export function mcpConfigFiles(configs: string[] | undefined, base: string = tmpdir()): { paths: string[]; dir?: string } {
  if (!configs?.some((c) => c.trimStart().startsWith('{'))) return { paths: configs ?? [] };
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(base, 'kelpie-mcp-'));
  const paths = configs.map((c, i) => {
    if (!c.trimStart().startsWith('{')) return c;
    const path = join(dir, `mcp-${i}.json`);
    writeFileSync(path, c, { mode: 0o600 });
    return path;
  });
  return { paths, dir };
}

/**
 * The environment a run's CLI gets. With an effort of its own, without CLAUDE_CODE_EFFORT_LEVEL: the
 * CLI lets that beat --effort, and quietly ignores a live change while it is set.
 */
export function runEnv(spec: Pick<RunSpec, 'env' | 'effort'>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base, ...spec.env };
  if (spec.effort) delete env.CLAUDE_CODE_EFFORT_LEVEL;
  return env;
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
  /** Where its MCP config files are, removed when it exits. */
  private mcpDir: string | undefined;
  /** Its effort is pinned by CLAUDE_CODE_EFFORT_LEVEL, which no live change gets past. */
  private effortPinned = false;

  constructor(spec: RunSpec) {
    this.runId = spec.runId ?? randomUUID();
    this.runDir = spec.runDir ?? join(homedir(), '.kelpie', 'runs', this.runId);
    this.parser = new ClaudeCodeParser({ runId: this.runId, todos: spec.todos });
    this.done = new Promise((r) => (this.resolveDone = r));

    const bin = spec.bin ?? 'claude';
    // rawLine pointers index raw.jsonl from line 1, so a directory holds exactly one run.
    if (existsSync(join(this.runDir, 'raw.jsonl'))) {
      throw new Error(`${this.runDir} already holds a run; start a new runId (continue a session with \`resume\`)`);
    }
    const mcp = mcpConfigFiles(spec.mcpConfig, spec.tempDir);
    this.mcpDir = mcp.dir;
    const args = claudeArgs({ ...spec, mcpConfig: mcp.paths });
    mkdirSync(this.runDir, { recursive: true });
    writeFileSync(
      join(this.runDir, 'run.json'),
      JSON.stringify({ runId: this.runId, harness: this.harness, cwd: spec.cwd, bin, args, startedAt: new Date().toISOString() }, null, 2),
    );
    this.raw = createWriteStream(join(this.runDir, 'raw.jsonl'), { flags: 'a' });

    const env = runEnv(spec);
    this.effortPinned = !!env.CLAUDE_CODE_EFFORT_LEVEL;
    this.child = spawn(bin, args, { cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    // A question's answers go back as part of its input, which is how the CLI hands them to the tool.
    const updatedInput = answer.allow && answer.answers ? { ...input, answers: answer.answers } : input;
    const response = answer.allow
      ? { behavior: 'allow', updatedInput, ...(answer.rules?.length ? { updatedPermissions: [{ type: 'addRules', rules: answer.rules.map(ruleParts), behavior: 'allow', destination: 'session' }] } : {}) }
      : { behavior: 'deny', message: answer.message };
    this.child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n');
    this.parser
      .noteAnswered(requestId, {
        decision: answer.allow ? 'allow' : 'deny',
        by: answer.by,
        ...(answer.allow ? (answer.answers ? { answers: answer.answers } : {}) : { message: answer.message }),
      })
      .forEach((ev) => this.emit(ev));
    return true;
  }

  async setMode(mode: string): Promise<boolean> {
    if (this.exit || this.stopping) return false;
    const res = await this.control({ subtype: 'set_permission_mode', mode });
    return res?.subtype === 'success';
  }

  async setEffort(effort: Effort): Promise<boolean> {
    // Pinned, the CLI answers success and changes nothing: only a new process (without the variable) takes it.
    if (this.exit || this.stopping || this.effortPinned) return false;
    // The session-scoped settings layer `--effort` sets; the CLI clamps a level the model lacks.
    const res = await this.control({ subtype: 'apply_flag_settings', settings: { effortLevel: effort } });
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
    if (this.mcpDir) rmSync(this.mcpDir, { recursive: true, force: true });
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

/** The CLI's words when a usage limit refuses a turn: "You've hit your session limit · resets 6pm (Asia/Calcutta)". */
const LIMIT_MESSAGE = /^You['\u2019]ve hit your .*\blimit\b/i;

/**
 * A turn that stopped at the usage limit: tagged so by the parser (with the reset time the CLI
 * reported, if it did), or, in a log from before it tagged them, a failure in the CLI's own words.
 * The reset time is read from the message when the CLI gave none.
 */
export function claudeLimitOf(event: KelpieEvent, now: Date = new Date()): UsageLimitStop | undefined {
  if (event.kind !== 'turn.ended' || event.data.status !== 'failed') return undefined;
  const message = event.data.error ?? '';
  if (!event.data.limit && !LIMIT_MESSAGE.test(message)) return undefined;
  const given = event.data.limit?.resetsAt ? new Date(event.data.limit.resetsAt) : undefined;
  const resetsAt = given && !Number.isNaN(given.getTime()) ? given : resetFromText(message, now);
  return { message: message || 'Usage limit reached', ...(resetsAt ? { resetsAt } : {}) };
}

export const claudeCode: Adapter = {
  harness: 'claude-code',
  modes: ['auto', 'acceptEdits', 'plan'],
  start: (spec) => new ClaudeCodeRun(spec),
  limitOf: claudeLimitOf,
};
