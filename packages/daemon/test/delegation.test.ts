import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import { openStore } from '@kelpie/store';
import { createApp, delegationNote, Orchestrator, SessionManager, WORK_TOOLS, Worktrees, type Session } from '../src/index.js';

const FAKE = join(import.meta.dirname, '../../adapters/test/fake-claude.mjs');
const FIXTURE = join(import.meta.dirname, '../../adapters/fixtures/claude-code/plain.jsonl');
chmodSync(FAKE, 0o755);

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const jsonLines = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', `edit ${file}`);
};

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
}

/** An origin with main, cloned into a checkout on a local branch of the person's own. */
function repo() {
  const origin = tmp('kelpie-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const seed = tmp('kelpie-seed-');
  git(seed, 'init', '-q', '-b', 'main');
  commit(seed, 'app.txt', 'one\ntwo\nthree\n');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  const checkout = join(tmp('kelpie-clone-'), 'acme');
  git(tmpdir(), 'clone', '-q', origin, checkout);
  git(checkout, 'checkout', '-qb', 'my-local-thing');
  return { checkout };
}

const managers: SessionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stopAll()));
});

function setup(env: Record<string, string> = {}, opts: { git?: boolean; idleMs?: number } = {}) {
  const checkout = opts.git === false ? tmp('kelpie-plain-') : repo().checkout;
  const store = openStore(':memory:');
  const argsFile = join(tmp('kelpie-args-'), 'args.jsonl');
  const stdin = join(tmp('kelpie-stdin-'), 'stdin.jsonl');
  const worktrees = new Worktrees({ store, root: join(tmp('kelpie-home-'), 'worktrees'), ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}) });
  const orch = new Orchestrator({ store, mcpUrl: 'http://127.0.0.1:7317/mcp', maxAgents: 6, notifyDelayMs: 200, worktrees });
  const sessions = new SessionManager({
    store,
    defaultCwd: checkout,
    runsDir: tmp('kelpie-runs-'),
    defaults: { bin: FAKE, env: { FAKE_FIXTURE: FIXTURE, FAKE_ARGS_FILE: argsFile, FAKE_STDIN_FILE: stdin, ...env } },
    hooks: orch,
    scratchDir: tmp('kelpie-scratch-'),
  });
  orch.attach(sessions);
  managers.push(sessions);
  return { store, orch, sessions, worktrees, app: createApp(sessions, { orchestrator: orch }), argsFile, stdin, checkout };
}

/** An orchestrator round-up at `create`'s level (balanced, the default, without one), its first start's argv and an MCP client as it. */
async function orchestrator(ctx: ReturnType<typeof setup>, create: Parameters<SessionManager['create']>[1] = {}) {
  const parent = ctx.sessions.create(undefined, create);
  await parent.send('Ship guest checkout');
  const argv = await waitFor(() => jsonLines<string[]>(ctx.argsFile)[0]);
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
  const ask = (tool: string, input: Record<string, unknown>) => ctx.orch.decide(parent, { requestId: 'q', tool, title: tool, input });
  return { parent, call, argv, ask };
}

/** A variadic flag's values: everything after it up to the next flag. */
function flag(args: string[], name: string): string[] {
  const i = args.indexOf(name);
  if (i < 0) return [];
  const end = args.findIndex((a, j) => j > i && a.startsWith('--'));
  return args.slice(i + 1, end < 0 ? undefined : end);
}

const idle = (s: Session) => s.events().some((e: KelpieEvent) => e.kind === 'turn.ended') && !s.working;
const exited = (s: Session, n = 1) => s.events().filter((e: KelpieEvent) => e.kind === 'process.exited').length >= n;
const log = (cwd: string) => git(cwd, 'log', '--format=%s');

describe('delegation levels', () => {
  it('gives the orchestrator only today’s tools at delegate, and edit, command and todo tools at solo and balanced, in its agents’ mode', async () => {
    const ctx = setup({ FAKE_HANG: '1' });
    const delegate = await orchestrator(ctx, { delegation: 'delegate' });
    const cwd = realpathSync(ctx.checkout);
    // Not made yet: its parent, resolved through links (macOS's /var is /private/var).
    const root = join(realpathSync(dirname(ctx.worktrees.root)), 'worktrees');
    expect(flag(delegate.argv, '--tools')).toEqual(['Read,Grep,Glob,AskUserQuestion,Edit,Write']);
    expect(flag(delegate.argv, '--permission-mode')).toEqual(['default']);
    expect(delegate.argv).not.toContain('--settings'); // no ask rules: in default mode every edit asks anyway
    expect(flag(delegate.argv, '--disallowedTools')).toEqual([`Edit(/${cwd}/**)`, `Write(/${cwd}/**)`, `Edit(/${root}/**)`, `Write(/${root}/**)`]);

    for (const delegation of ['balanced', 'solo'] as const) {
      const before = jsonLines(ctx.argsFile).length;
      const parent = ctx.sessions.create(undefined, { delegation });
      await parent.send('Fix the typo');
      const argv = await waitFor(() => jsonLines<string[]>(ctx.argsFile)[before]);
      expect(flag(argv, '--tools')).toEqual([['Read', 'Grep', 'Glob', 'AskUserQuestion', 'Edit', 'Write', ...WORK_TOOLS].join(',')]);
      expect(WORK_TOOLS).toEqual(['Bash', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
      // The same auto mode as its agents: its commands go by the harness's own checks.
      expect(flag(argv, '--permission-mode')).toEqual(['auto']);
      // Its cwd stays the person's checkout (its conversation is kept by directory, for --resume).
      expect(parent.cwd).toBe(ctx.checkout);
      // Every edit still asks, whatever auto mode would let through, so `decide` holds them to its places.
      expect(JSON.parse(flag(argv, '--settings')[0]!)).toEqual({ permissions: { ask: ['Edit', 'Write'] } });
      // Its repo is denied by rule; Kelpie's worktrees are not, its feature checkout being among them.
      expect(flag(argv, '--disallowedTools')).toEqual([`Edit(/${cwd}/**)`, `Write(/${cwd}/**)`]);
      expect(flag(argv, '--allowedTools')).toEqual(['mcp__kelpie', `Read(/${parent.scratch}/**)`]);
      // No feature checkout yet: nothing to add for it.
      expect(flag(argv, '--add-dir')).toEqual([parent.scratch]);
    }
  });

  it('adds the feature checkout once it is open, and follows the round-up mode as its agents do', async () => {
    const ctx = setup({ FAKE_EVERY_TURN: '1' });
    const { parent, call } = await orchestrator(ctx, { delegation: 'solo' });
    await call('set_base_branch', { branch: 'origin/main' });
    const { data } = await call('open_feature_checkout');
    const home = ctx.store.worktreeOf(parent.id)!;
    await waitFor(() => idle(parent));
    await ctx.sessions.setMode(parent, 'acceptEdits'); // restarts it once idle
    await waitFor(() => exited(parent));
    await parent.send('Carry on');
    const next = await waitFor(() => jsonLines<string[]>(ctx.argsFile)[1]);
    expect(flag(next, '--resume')).toHaveLength(1);
    expect(flag(next, '--add-dir')).toEqual([parent.scratch, realpathSync(data.featureCheckout)]);
    expect(data.featureCheckout).toBe(home.path);
    expect(flag(next, '--permission-mode')).toEqual(['acceptEdits']);

    await waitFor(() => idle(parent));
    await ctx.sessions.setMode(parent, 'plan');
    await waitFor(() => exited(parent, 2));
    await parent.send('Plan it');
    const planning = await waitFor(() => jsonLines<string[]>(ctx.argsFile)[2]);
    expect(flag(planning, '--permission-mode')).toEqual(['plan']);
    expect(flag(planning, '--tools')[0]).toMatch(/,ExitPlanMode$/);
  });

  it('lets an orchestrator that works itself edit its feature checkout, but not in plan mode or while Muster merges there', async () => {
    const ctx = setup({ FAKE_HANG: '1' });
    const { parent, call, ask } = await orchestrator(ctx, { delegation: 'balanced' });
    const cwd = realpathSync(ctx.checkout);
    // No checkout yet: it is told how to make one.
    expect(ask('Edit', { file_path: join(cwd, 'app.txt') })).toMatchObject({ allow: false, message: expect.stringMatching(/open_feature_checkout makes it/) });
    await call('set_base_branch', { branch: 'origin/main' });
    await call('open_feature_checkout');
    const home = realpathSync(ctx.store.worktreeOf(parent.id)!.path);
    const allowed = (tool: string, input: Record<string, unknown>) => ask(tool, input)?.allow;

    expect(allowed('Edit', { file_path: join(home, 'app.txt') })).toBe(true);
    expect(allowed('Write', { file_path: join(home, 'src', 'new.ts'), content: 'x' })).toBe(true);
    expect(allowed('Write', { file_path: join(parent.scratch!, 'notes.md'), content: 'x' })).toBe(true);
    expect(allowed('TaskCreate', { subject: 'x' })).toBe(true);
    // Its commands go to the person (the round-up's saved rules first), as an agent's do.
    expect(ask('Bash', { command: 'pnpm test' })).toBeUndefined();
    // Never the person's checkout, git's metadata, a relative path (from its cwd, the person's checkout), or a way out.
    expect(allowed('Edit', { file_path: join(cwd, 'app.txt') })).toBe(false);
    expect(allowed('Write', { file_path: 'app.txt', content: 'x' })).toBe(false);
    expect(ask('Write', { file_path: join(home, '.git'), content: 'x' })).toMatchObject({ allow: false, message: expect.stringMatching(/\.git is Kelpie's/) });
    expect(allowed('Edit', { file_path: `${home}/../escape.txt` })).toBe(false);
    expect(allowed('Edit', { file_path: `${home}x/app.txt` })).toBe(false);
    expect(ask('Edit', { file_path: join(cwd, 'app.txt') })).toMatchObject({ message: expect.stringContaining(`edit files in your feature checkout (${ctx.store.worktreeOf(parent.id)!.path}`) });

    // Muster at work in the feature checkout: no edits under it.
    const muster = ctx.sessions.create(ctx.store.worktreeOf(parent.id)!.path, { parentId: parent.id, role: 'agent', kind: 'muster', writes: true, title: 'Muster: API' });
    await muster.send('merge');
    await waitFor(() => muster.working);
    expect(ask('Edit', { file_path: join(home, 'app.txt') })).toMatchObject({ allow: false, message: expect.stringMatching(/Muster \("Muster: API"\) is merging/) });
    await muster.interrupt();
    await ctx.sessions.delete(muster.id);
    expect(allowed('Edit', { file_path: join(home, 'app.txt') })).toBe(true);

    await ctx.sessions.setMode(parent, 'plan');
    expect(ask('Edit', { file_path: join(home, 'app.txt') })).toMatchObject({ allow: false, message: expect.stringMatching(/plan mode/) });

    // At delegate the feature checkout is read-only to it again, and commands are refused.
    const other = setup({ FAKE_HANG: '1' });
    const d = await orchestrator(other, { delegation: 'delegate' });
    await d.call('set_base_branch', { branch: 'origin/main' });
    await d.call('open_feature_checkout');
    const dHome = realpathSync(other.store.worktreeOf(d.parent.id)!.path);
    expect(d.ask('Read', { file_path: join(dHome, 'app.txt') })).toMatchObject({ allow: true });
    expect(d.ask('Edit', { file_path: join(dHome, 'app.txt') })).toMatchObject({ allow: false });
    expect(d.ask('Bash', { command: 'pnpm test' })).toMatchObject({ allow: false, message: expect.stringMatching(/Give changes, commands/) });
    expect(d.ask('TaskCreate', { subject: 'x' })).toMatchObject({ allow: false });
  });

  it('opens the feature checkout from the base branch, which fixes the base, and brings it back if swept', async () => {
    const ctx = setup({ FAKE_HANG: '1' });
    const { parent, call } = await orchestrator(ctx);
    expect((await call('open_feature_checkout')).error).toMatch(/No base branch.*then open the feature checkout/);
    await call('set_base_branch', { branch: 'origin/main' });
    const { data } = await call('open_feature_checkout');
    const home = ctx.store.worktreeOf(parent.id)!;
    expect(data).toEqual({ featureCheckout: home.path, featureBranch: home.branch, baseBranch: 'origin/main' });
    expect(git(home.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(home.branch);
    expect(readFileSync(join(home.path, 'app.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect((await call('set_base_branch', { branch: 'origin/main' })).error).toMatch(/can't change now/);
    expect((await call('open_feature_checkout')).data).toEqual(data);

    await ctx.worktrees.remove(home); // as the sweep would
    expect(existsSync(home.path)).toBe(false);
    expect((await call('open_feature_checkout')).data).toEqual(data);
    expect(existsSync(join(home.path, 'app.txt'))).toBe(true);

    // Outside a git repo there is nothing to open.
    const plain = setup({ FAKE_HANG: '1' }, { git: false });
    const p = await orchestrator(plain);
    expect((await p.call('open_feature_checkout')).error).toMatch(/not a git repository/);
  });

  it('commits the orchestrator’s edits before a writer forks, before mustering, and when its turn ends; never at delegate', async () => {
    const ctx = setup({ FAKE_EVERY_TURN: '1' });
    const { parent, call } = await orchestrator(ctx, { delegation: 'balanced' });
    await call('set_base_branch', { branch: 'origin/main' });
    const { data } = await call('open_feature_checkout');
    const home = data.featureCheckout as string;

    // A writer forks from the feature branch's last commit: the orchestrator's edits go in first.
    writeFileSync(join(home, 'notes.txt'), 'by the orchestrator\n');
    const { data: spawned } = await call('spawn_agent', { title: 'API', task: 'x', writes: true });
    expect(log(home).split('\n')[0]).toBe('kelpie: orchestrator edits (notes.txt)');
    expect(git(home, 'status', '--porcelain')).toBe('');
    const writer = ctx.sessions.get(spawned.agentId)!;
    expect(readFileSync(join(writer.cwd, 'notes.txt'), 'utf8')).toBe('by the orchestrator\n');

    // A merge refuses uncommitted work in the feature checkout: committed first, so it merges cleanly.
    await waitFor(() => ctx.store.getSession(writer.id)!.notifiedIdx >= 0);
    commit(writer.cwd, 'api.txt', 'api\n');
    writeFileSync(join(home, 'a.txt'), 'a\n');
    writeFileSync(join(home, 'b.txt'), 'b\n');
    writeFileSync(join(home, 'c.txt'), 'c\n');
    writeFileSync(join(home, 'd.txt'), 'd\n');
    const mustered = await call('muster_agents', { agentIds: [writer.id] });
    expect(mustered.error).toBeUndefined();
    expect(mustered.data.merged).toEqual(['API']);
    expect(log(home)).toContain('kelpie: orchestrator edits (a.txt, b.txt, c.txt and 1 more)');
    expect(git(home, 'show', 'HEAD:api.txt')).toBe('api');

    // Its turn over, what it left is committed, and the feature's Changes are told to refresh.
    await waitFor(() => idle(parent));
    const changes: string[] = [];
    ctx.sessions.watch((u) => u.type === 'changes' && u.roundUpId === parent.id && changes.push(u.sessionId));
    writeFileSync(join(home, 'later.txt'), 'later\n');
    // Uncommitted meanwhile, the feature's Changes show it.
    const view = await ctx.orch.changes.of(parent.id);
    expect(view).toMatchObject({ scope: 'feature', dirty: true });
    expect(view!.files.map((f) => f.path)).toContain('later.txt');
    await parent.send('And one more thing');
    await waitFor(() => log(home).split('\n')[0] === 'kelpie: orchestrator edits (later.txt)');
    await waitFor(() => changes.includes(parent.id));
    const after = await ctx.orch.changes.of(parent.id);
    expect(after!.dirty).toBeUndefined();
    expect(after!.files.map((f) => f.path)).toContain('later.txt');

    // At delegate, Kelpie leaves the feature checkout as it is: today's behaviour.
    const other = setup({ FAKE_EVERY_TURN: '1' });
    const d = await orchestrator(other, { delegation: 'delegate' });
    await d.call('set_base_branch', { branch: 'origin/main' });
    const dHome = (await d.call('open_feature_checkout')).data.featureCheckout as string;
    writeFileSync(join(dHome, 'stray.txt'), 'x\n');
    await waitFor(() => idle(d.parent));
    await d.parent.send('Next');
    await waitFor(() => d.parent.events().filter((e) => e.kind === 'turn.ended').length >= 2 && !d.parent.working);
    await sleep(200);
    expect(git(dHome, 'status', '--porcelain')).toBe('?? stray.txt');
  });

  it('keeps the feature checkout from the sweep while an orchestrator that works there is working', async () => {
    const ctx = setup({ FAKE_HANG: '1' }, { idleMs: 0 });
    const { parent, call } = await orchestrator(ctx, { delegation: 'solo' });
    await call('set_base_branch', { branch: 'origin/main' });
    await call('open_feature_checkout');
    expect(parent.working).toBe(true);
    expect(await ctx.orch.sweep()).toBe(0);
    expect(ctx.store.worktreeOf(parent.id)!.state).toBe('active');

    // An orchestrator that only coordinates never works there: its checkout may go.
    const other = setup({ FAKE_HANG: '1' }, { idleMs: 0 });
    const d = await orchestrator(other, { delegation: 'delegate' });
    await d.call('set_base_branch', { branch: 'origin/main' });
    await d.call('open_feature_checkout');
    expect(await other.orch.sweep()).toBe(1);
  });

  it('restarts the orchestrator on a level change and tells it once with its next turn', async () => {
    const ctx = setup({ FAKE_EVERY_TURN: '1' });
    const { parent, argv } = await orchestrator(ctx, { delegation: 'delegate' });
    expect(flag(argv, '--tools')[0]).not.toContain('Bash');
    await waitFor(() => idle(parent));
    // As the API does: saved on the round-up, then the orchestrator is told.
    const res = await ctx.app.request(`/api/sessions/${parent.id}`, { method: 'PATCH', headers: { host: '127.0.0.1:7317', 'content-type': 'application/json' }, body: JSON.stringify({ delegation: 'solo' }) });
    expect(res.status).toBe(200);
    expect(parent.delegation).toBe('solo');
    await waitFor(() => exited(parent));
    await parent.send('Fix the typo yourself');
    const next = await waitFor(() => jsonLines<string[]>(ctx.argsFile)[1]);
    expect(flag(next, '--resume')).toHaveLength(1);
    expect(flag(next, '--tools')[0]).toContain('Bash');
    const sent = await waitFor(() => jsonLines<{ text: string }>(ctx.stdin).find((l) => l.text.startsWith('Fix the typo yourself')));
    expect(sent.text).toBe(`Fix the typo yourself\n\n${delegationNote('solo')}`);
    expect(delegationNote('solo')).toContain("delegation level to solo: do the work yourself");

    // Once only.
    await waitFor(() => idle(parent) && jsonLines(ctx.stdin).length >= 2);
    await parent.send('Thanks');
    const thanks = await waitFor(() => jsonLines<{ text: string }>(ctx.stdin).find((l) => l.text.startsWith('Thanks')));
    expect(thanks.text).toBe('Thanks');

    // Two changes before its next turn: it hears the last.
    ctx.orch.setDelegation(parent.id, 'balanced');
    ctx.orch.setDelegation(parent.id, 'delegate');
    await waitFor(() => idle(parent));
    await parent.send('Go on');
    const goOn = await waitFor(() => jsonLines<{ text: string }>(ctx.stdin).find((l) => l.text.startsWith('Go on')));
    expect(goOn.text).toBe(`Go on\n\n${delegationNote('delegate')}`);
  });

  it('commits what the orchestrator left when the person hands the work back to agents', async () => {
    const ctx = setup({ FAKE_EVERY_TURN: '1' });
    const { parent, call } = await orchestrator(ctx, { delegation: 'balanced' });
    await call('set_base_branch', { branch: 'origin/main' });
    const home = (await call('open_feature_checkout')).data.featureCheckout as string;
    await waitFor(() => idle(parent));
    writeFileSync(join(home, 'wip.txt'), 'wip\n');
    ctx.sessions.setDelegation(parent, 'delegate');
    ctx.orch.setDelegation(parent.id, 'delegate');
    await waitFor(() => log(home).split('\n')[0] === 'kelpie: orchestrator edits (wip.txt)');
  });

  it('applies the round-up’s saved command rules to an orchestrator that works itself, never its edit rules', async () => {
    const answers = join(tmp('kelpie-answers-'), 'answers.jsonl');
    const ctx = setup({ FAKE_ASK: 'pnpm test', FAKE_ANSWER_FILE: answers });
    const parent = ctx.sessions.create(undefined, { delegation: 'balanced' });
    ctx.store.addRule(parent.id, 'Bash(pnpm test)');
    ctx.store.addRule(parent.id, 'Edit');
    await parent.send('Run the tests');
    const argv = await waitFor(() => jsonLines<string[]>(ctx.argsFile)[0]);
    expect(flag(argv, '--allowedTools')).toEqual(['mcp__kelpie', `Read(/${parent.scratch}/**)`, 'Bash(pnpm test)']);
    await waitFor(() => jsonLines(answers).length > 0);
    expect(jsonLines<{ behavior: string }>(answers)[0]).toMatchObject({ behavior: 'allow' });

    // Without a rule, its command waits for the person; at delegate, none apply and Kelpie refuses it.
    const other = setup({ FAKE_ASK: 'pnpm test' });
    const p = other.sessions.create(undefined, { delegation: 'balanced' });
    await p.send('Run the tests');
    await waitFor(() => p.approvals().length === 1);
    expect(p.approvals()[0]).toMatchObject({ tool: 'Bash' });
    const res = await other.app.request('/api/approvals', {
      method: 'POST',
      headers: { host: '127.0.0.1:7317', 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ sessionId: p.id, requestId: p.approvals()[0]!.requestId }], decision: 'allow', remember: true }),
    });
    expect(res.status).toBe(200);
    // "Allow for round-up" on its command is saved for the round-up.
    await waitFor(() => other.store.rulesOf(p.id).length === 1);
    expect(other.store.rulesOf(p.id).map((r) => r.rule)).toEqual(['Bash(pnpm test)']);
  });
});
