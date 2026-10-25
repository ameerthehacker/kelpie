import { execFile } from 'node:child_process';
import type { Harness } from '@kelpie/protocol';
import which from 'which';

/** Whether a harness CLI is ready for Kelpie to drive: installed, and signed in. */
export interface HarnessStatus {
  harness: Harness;
  installed: boolean;
  /** Where the CLI resolved to on PATH. */
  path?: string;
  /** As the CLI reports it, e.g. `2.1.308`. */
  version?: string;
  /** Null when the CLI couldn't say (an older version without an auth check). */
  loggedIn: boolean | null;
  /** How it is signed in, as the CLI says it: `claude.ai`, `api_key`, `third_party`… */
  authMethod?: string;
  /** What went wrong while checking, if anything did. */
  error?: string;
  checkedAt: string;
}

export interface CheckOptions {
  /** The CLI to check: a command looked up on PATH, or a path. Default `claude`. */
  bin?: string;
  /** The environment agents run with (PATH, API keys). Default `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const TIMEOUT_MS = 15_000;

interface Output {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a CLI to completion; a non-zero exit is an answer (stdout kept), only a failure to run throws. */
function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<Output> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = (err as { code?: unknown } | null)?.code;
      if (err && typeof code !== 'number') return reject(err);
      resolve({ code: typeof code === 'number' ? code : 0, stdout, stderr });
    });
  });
}

const lastLine = (o: Output) => (o.stderr || o.stdout).trim().split('\n').at(-1) ?? '';

/** `2.1.308 (Claude Code)` → `2.1.308`. */
export const parseVersion = (out: string): string | undefined => /\d+\.\d+\.\d+(?:[-+][\w.-]+)?/.exec(out)?.[0];

/**
 * Claude Code: on PATH, its version, and whether it is signed in. `claude auth status --json` answers
 * from local credentials (no request, no tokens) and covers every kind of sign-in: a claude.ai account,
 * an API key, Bedrock or Vertex. A CLI too old to have it falls back to the env vars that sign it in.
 */
export async function claudeCodeStatus(opts: CheckOptions = {}): Promise<HarnessStatus> {
  const env = opts.env ?? process.env;
  const base = { harness: 'claude-code' as const, checkedAt: new Date().toISOString() };
  const path = await which(opts.bin ?? 'claude', { nothrow: true, path: env.PATH });
  if (!path) return { ...base, installed: false, loggedIn: false };

  let version: string | undefined;
  try {
    const out = await run(path, ['--version'], env);
    version = parseVersion(out.stdout);
    if (out.code !== 0) return { ...base, installed: true, path, loggedIn: null, error: lastLine(out) || `\`claude --version\` exited with ${out.code}` };
  } catch (err) {
    return { ...base, installed: true, path, loggedIn: null, error: (err as Error).message };
  }

  const found = { ...base, installed: true, path, ...(version ? { version } : {}) };
  try {
    // Exits 1 when signed out, still with the JSON.
    const out = await run(path, ['auth', 'status', '--json'], env);
    const auth = JSON.parse(out.stdout) as { loggedIn?: unknown; authMethod?: unknown };
    if (typeof auth.loggedIn !== 'boolean') throw new Error('no loggedIn');
    return { ...found, loggedIn: auth.loggedIn, ...(typeof auth.authMethod === 'string' && auth.loggedIn ? { authMethod: auth.authMethod } : {}) };
  } catch {
    if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return { ...found, loggedIn: true, authMethod: env.ANTHROPIC_API_KEY ? 'api_key' : 'oauth_token' };
    return { ...found, loggedIn: null };
  }
}

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
