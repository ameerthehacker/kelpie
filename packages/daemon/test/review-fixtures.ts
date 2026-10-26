import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openStore, type Store } from '@kelpie/store';
import { createApp, Orchestrator, SessionManager, Worktrees, type Session } from '../src/index.js';

/** Git repos, a daemon over the fake harness, and MCP clients, for the Changes and review tests. */

const FAKE = join(import.meta.dirname, '../../adapters/test/fake-claude.mjs');
const FIXTURE = join(import.meta.dirname, '../../adapters/fixtures/claude-code/plain.jsonl');
chmodSync(FAKE, 0o755);

export const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
export const jsonLines = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
export const commit = (cwd: string, file: string, text: string | Buffer) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', `edit ${file}`);
};
/** `l1` to `l20`, one per line, with some replaced. */
export const lines = (replace: Record<number, string> = {}, extra: { before?: string[] } = {}) =>
  [...(extra.before ?? []), ...Array.from({ length: 20 }, (_, i) => replace[i + 1] ?? `l${i + 1}`)].join('\n') + '\n';

export async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
}

/** An origin with main (app.txt: twenty lines; base.txt: three), cloned into a checkout. */
export function repo(): string {
  const origin = tmp('kelpie-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const seed = tmp('kelpie-seed-');
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'base.txt'), 'keep\ndrop\nend\n');
  commit(seed, 'app.txt', lines());
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  const checkout = join(tmp('kelpie-clone-'), 'acme');
  git(tmpdir(), 'clone', '-q', origin, checkout);
  return checkout;
}

export const LOCAL = { host: '127.0.0.1:7317', 'content-type': 'application/json' };

export function setup(opts: { env?: Record<string, string>; store?: Store; checkout?: string; root?: string; maxAgents?: number } = {}) {
  const checkout = opts.checkout ?? repo();
  const store = opts.store ?? openStore(':memory:');
  const argsFile = join(tmp('kelpie-args-'), 'args.jsonl');
  const stdinFile = join(tmp('kelpie-stdin-'), 'stdin.jsonl');
  const worktrees = new Worktrees({ store, root: opts.root ?? join(tmp('kelpie-home-'), 'worktrees') });
  const orch = new Orchestrator({ store, mcpUrl: 'http://127.0.0.1:7317/mcp', maxAgents: opts.maxAgents ?? 6, notifyDelayMs: 100, worktrees });
  const sessions = new SessionManager({
    store,
    defaultCwd: checkout,
    runsDir: tmp('kelpie-runs-'),
    defaults: { bin: FAKE, env: { FAKE_FIXTURE: FIXTURE, FAKE_ARGS_FILE: argsFile, FAKE_STDIN_FILE: stdinFile, FAKE_EVERY_TURN: '1', ...opts.env } },
    hooks: orch,
  });
  orch.attach(sessions);
  const app = createApp(sessions, { orchestrator: orch });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: LOCAL, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  return { store, orch, sessions, worktrees, app, api, argsFile, stdinFile, checkout };
}
export type Ctx = ReturnType<typeof setup>;

/** An MCP client holding the token in one harness start's `--mcp-config`. */
export async function mcpClient(ctx: Ctx, argv: string[]) {
  const { url, headers } = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!).mcpServers.kelpie;
  const client = new Client({ name: 'test', version: '0' });
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    h.set('host', '127.0.0.1:7317');
    return Promise.resolve(ctx.app.request(String(input instanceof Request ? input.url : input), { ...init, headers: h }));
  };
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers }, fetch }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content[0]!.text;
    return { error: res.isError ? text : undefined, data: res.isError ? undefined : JSON.parse(text) };
  };
  const tools = async () => (await client.listTools()).tools.map((t) => t.name).sort();
  return { call, tools, close: () => client.close() };
}

/** The latest harness start whose system prompt mentions `text` (e.g. an agent's branch). */
export const startWith = (ctx: Ctx, text: string) => waitFor(() => jsonLines<string[]>(ctx.argsFile).findLast((a) => a.join(' ').includes(text)));

/** A round-up with its base set; its orchestrator has had a first turn, so later turns echo as sent. */
export async function roundUp(ctx: Ctx): Promise<Session> {
  const parent = ctx.sessions.create();
  await parent.send('Ship it');
  await waitFor(() => parent.lastTurn && !parent.working);
  await ctx.orch.setBase(parent, 'origin/main');
  return parent;
}

/** A writer, spawned and idle (its first turn reported), with its worktree ready for test commits. */
export async function writer(ctx: Ctx, parent: Session, title: string, deliver?: 'muster' | 'standalone'): Promise<Session> {
  const { agentId } = await ctx.orch.spawn(parent, { title, task: `do ${title}`, writes: true, ...(deliver ? { deliver } : {}) });
  await waitFor(() => ctx.store.getSession(agentId)!.notifiedIdx >= 0);
  return ctx.sessions.get(agentId)!;
}

/** Waits until an agent has gone idle and been reported again after `since`. */
export const reported = (ctx: Ctx, agent: Session, since: number) => waitFor(() => !agent.working && ctx.store.getSession(agent.id)!.notifiedIdx > since);
