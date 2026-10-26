import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { HarnessStatus } from '@kelpie/protocol';
import which from 'which';

export type { HarnessStatus };

export interface CheckOptions {
  /** The CLI to check: a command looked up on PATH, or a path. Default `claude`. */
  bin?: string;
  /** The environment agents run with (PATH, API keys). Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Where to look when it isn't on PATH. Default `installDirs(env)`. */
  installDirs?: string[];
  /** How long each CLI command may take before it is killed. Default 10s. */
  timeoutMs?: number;
  /** How long the whole check may take; past it, it answers with what it found so far. Default 25s. */
  deadlineMs?: number;
}

const TIMEOUT_MS = 10_000;
const DEADLINE_MS = 25_000;

interface Output {
  code: number;
  stdout: string;
  stderr: string;
}

const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;

/**
 * Runs a CLI to completion; a non-zero exit is an answer (stdout kept), only a failure to run throws.
 * Past `timeoutMs` it is killed outright (SIGKILL: one that ignores SIGTERM would keep everyone waiting),
 * and its pipes are closed even if something it started still holds them.
 */
function run(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Output> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const { code, killed } = (err ?? {}) as { code?: unknown; killed?: boolean };
      if (err && killed && code == null) return reject(new Error(`\`claude ${args.join(' ')}\` didn't answer within ${seconds(timeoutMs)}`));
      if (err && typeof code !== 'number') return reject(err);
      resolve({ code: typeof code === 'number' ? code : 0, stdout, stderr });
    });
  });
}

const lastLine = (o: Output) => (o.stderr || o.stdout).trim().split('\n').at(-1) ?? '';

/** `2.1.308 (Claude Code)` → `2.1.308`. */
export const parseVersion = (out: string): string | undefined => /\d+\.\d+\.\d+(?:[-+][\w.-]+)?/.exec(out)?.[0];

/** `claude auth status --json`'s answer, or undefined when it isn't one (an older CLI, garbled output). */
function parseAuth(out: string): { loggedIn: boolean; authMethod?: string } | undefined {
  try {
    const auth = JSON.parse(out) as { loggedIn?: unknown; authMethod?: unknown };
    if (typeof auth.loggedIn !== 'boolean') return undefined;
    return { loggedIn: auth.loggedIn, ...(typeof auth.authMethod === 'string' ? { authMethod: auth.authMethod } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * Where Claude Code's installers put `claude`. A daemon started from an app, or from a terminal opened
 * before installing, often doesn't have these on PATH: the native installer's `~/.local/bin` above all.
 */
export function installDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === 'win32') return [join(home, '.local', 'bin'), ...(env.APPDATA ? [join(env.APPDATA, 'npm')] : [])];
  return [
    join(home, '.local', 'bin'), // the native installer
    join(home, '.claude', 'local'), // the older local install
    ...(env.NPM_CONFIG_PREFIX ? [join(env.NPM_CONFIG_PREFIX, 'bin')] : []),
    join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

/**
 * Claude Code: where it is, its version, and whether it is signed in. `claude auth status --json`
 * answers from local credentials (no request, no tokens) and covers every kind of sign-in: a claude.ai
 * account, an API key, Bedrock or Vertex. A CLI too old to have it falls back to the env vars that sign
 * it in. One found only off PATH is still asked, but reported `onPath: false`: agents are started as
 * `claude`, so Kelpie can't run them until it is on the PATH Kelpie was started with.
 *
 * Always settles within `deadlineMs`, with whatever it found by then: callers share one check, so one
 * that hung would hang them all.
 */
export async function claudeCodeStatus(opts: CheckOptions = {}): Promise<HarnessStatus> {
  const env = opts.env ?? process.env;
  const bin = opts.bin ?? 'claude';
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
  // What is known so far, which is the answer if the deadline comes first.
  let known: HarnessStatus = { harness: 'claude-code', installed: false, loggedIn: null, platform: process.platform };

  const check = async (): Promise<HarnessStatus> => {
    const onPath = await which(bin, { nothrow: true, path: env.PATH });
    const dirs = opts.installDirs ?? installDirs(env);
    const path = onPath ?? (dirs.length && !/[\\/]/.test(bin) ? await which(bin, { nothrow: true, path: dirs.join(delimiter) }) : null);
    if (!path) return { ...known, loggedIn: false };
    known = { ...known, installed: true, path, onPath: !!onPath };

    try {
      const out = await run(path, ['--version'], env, timeoutMs);
      const version = parseVersion(out.stdout);
      if (version) known = { ...known, version };
      if (out.code !== 0) return { ...known, error: lastLine(out) || `\`claude --version\` exited with ${out.code}` };
    } catch (err) {
      return { ...known, error: (err as Error).message };
    }

    let failed: string | undefined;
    try {
      // Exits 1 when signed out, still with the JSON.
      const auth = parseAuth((await run(path, ['auth', 'status', '--json'], env, timeoutMs)).stdout);
      if (auth) return { ...known, loggedIn: auth.loggedIn, ...(auth.loggedIn && auth.authMethod ? { authMethod: auth.authMethod } : {}) };
    } catch (err) {
      failed = (err as Error).message;
    }
    if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return { ...known, loggedIn: true, authMethod: env.ANTHROPIC_API_KEY ? 'api_key' : 'oauth_token' };
    return { ...known, ...(failed ? { error: failed } : {}) };
  };

  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<HarnessStatus>((resolve) => {
    timer = setTimeout(() => resolve({ ...known, loggedIn: null, error: `Claude Code didn't answer within ${seconds(deadlineMs)}` }), deadlineMs);
  });
  try {
    return await Promise.race([check(), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether Kelpie can start this harness now: there is a CLI on its PATH (signed in or not). */
export const canStart = (s: HarnessStatus) => s.installed && s.onPath !== false;

/** Every harness Kelpie can drive, checked afresh. Only Claude Code so far. */
export function checkHarnesses(opts: CheckOptions = {}): Promise<HarnessStatus[]> {
  return Promise.all([claudeCodeStatus(opts)]);
}

/**
 * `check`, with callers that arrive while one is running sharing it (several tabs pressing
 * "Check again"). Nothing is kept once it finishes: the next call checks again.
 */
export function shared<T>(check: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | undefined;
  return () => (running ??= check().finally(() => (running = undefined)));
}
