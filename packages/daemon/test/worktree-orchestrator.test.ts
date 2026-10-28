import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import { openStore } from '@kelpie/store';
import { BaseFixedError, createApp, HALTED, Orchestrator, SessionManager, ToolError, Worktrees, type Session } from '../src/index.js';

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

/** An origin with main and release, cloned into a checkout sitting on an unrelated local branch. */
function repo() {
  const origin = tmp('kelpie-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const seed = tmp('kelpie-seed-');
  git(seed, 'init', '-q', '-b', 'main');
  commit(seed, 'app.txt', 'one\ntwo\nthree\n');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-qb', 'release');
  commit(seed, 'release.txt', 'r\n');
  git(seed, 'push', '-q', 'origin', 'release');
  const checkout = join(tmp('kelpie-clone-'), 'acme');
  git(tmpdir(), 'clone', '-q', origin, checkout);
  git(checkout, 'checkout', '-qb', 'my-local-thing');
  commit(checkout, 'local.txt', 'not for the round-up\n');
  return { checkout, release: git(seed, 'rev-parse', 'HEAD') };
}

const managers: SessionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stopAll()));
});

function setup(env: Record<string, string> = {}, maxAgents = 6, scratch = false) {
  const { checkout, release } = repo();
  const store = openStore(':memory:');
  const argsFile = join(tmp('kelpie-args-'), 'args.jsonl');
  const worktrees = new Worktrees({ store, root: join(tmp('kelpie-home-'), 'worktrees') });
  const orch = new Orchestrator({ store, mcpUrl: 'http://127.0.0.1:7317/mcp', maxAgents, notifyDelayMs: 200, worktrees });
  const sessions = new SessionManager({
    store,
    defaultCwd: checkout,
    runsDir: tmp('kelpie-runs-'),
    defaults: { bin: FAKE, env: { FAKE_FIXTURE: FIXTURE, FAKE_ARGS_FILE: argsFile, ...env } },
    hooks: orch,
    ...(scratch ? { scratchDir: tmp('kelpie-scratch-') } : {}),
  });
  orch.attach(sessions);
  managers.push(sessions);
  return { store, orch, sessions, worktrees, app: createApp(sessions, { orchestrator: orch }), argsFile, checkout, release };
}

async function orchestrator(ctx: ReturnType<typeof setup>, create: Parameters<SessionManager['create']>[1] = {}) {
  // Today's orchestrator, which only coordinates, unless a test picks another level.
  const parent = ctx.sessions.create(undefined, { delegation: 'delegate', ...create });
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
  return { parent, call, argv };
}

/** A variadic flag's values: everything after it up to the next flag. */
function flag(args: string[], name: string): string[] {
  const i = args.indexOf(name);
  if (i < 0) return [];
  const end = args.findIndex((a, j) => j > i && a.startsWith('--'));
  return args.slice(i + 1, end < 0 ? undefined : end);
}

const idle = (s: Session) => s.events().some((e: KelpieEvent) => e.kind === 'turn.ended') && !s.working;
const notes = (s: Session) => s.events().flatMap((e: KelpieEvent) => (e.kind === 'message' && e.data.source === 'kelpie' ? [e.data.text] : []));

describe('worktrees for writing agents', () => {
  it('asks for a base branch, pins it, and runs writers side by side, each on its own branch', async () => {
    const ctx = setup({ FAKE_HANG: '1' });
    const { parent, call } = await orchestrator(ctx);

    expect((await call('spawn_agent', { title: 'API', task: 'x', writes: true })).error).toMatch(/No base branch.*Ask the person/);
    // Reading needs no base: it looks at the round-up's directory.
    const reader = await call('spawn_agent', { title: 'Look around', task: 'x', writes: false });
    expect(ctx.sessions.get(reader.data.agentId)!.cwd).toBe(ctx.checkout);

    const { data: listed } = await call('list_branches');
    expect(listed.branches.slice(0, 2).map((b: { name: string }) => b.name).sort()).toEqual(['origin/main', 'origin/release']);
    expect((await call('set_base_branch', { branch: 'origin/release' })).data).toEqual({ baseBranch: 'origin/release', baseCommit: ctx.release });

    const a = await call('spawn_agent', { title: 'Checkout API', task: 'build the API', writes: true });
    const b = await call('spawn_agent', { title: 'Guest UI', task: 'build the UI', writes: true, deliver: 'standalone' });
    expect(a.error ?? b.error).toBeUndefined(); // no "one writer per repo" any more
    const [wa, wb] = [ctx.store.worktreeOf(a.data.agentId)!, ctx.store.worktreeOf(b.data.agentId)!];
    const home = ctx.store.worktreeOf(parent.id)!;
    expect(ctx.sessions.get(a.data.agentId)!.cwd).toBe(wa.path);
    expect(wa.path).not.toBe(wb.path);
    expect(git(home.path, 'rev-parse', 'HEAD')).toBe(ctx.release); // from the chosen base, not the checkout's branch
    expect(existsSync(join(wa.path, 'local.txt'))).toBe(false);
    expect(wb).toMatchObject({ deliver: 'standalone', parentBranch: home.branch, baseBranch: 'origin/release' });

    // Each writer is told where it works and what it is based on.
    const argv = await waitFor(() => jsonLines<string[]>(ctx.argsFile).find((x) => x.join(' ').includes(wa.branch)));
    const prompt = argv[argv.indexOf('--append-system-prompt') + 1]!;
    expect(prompt).toContain(`branch \`${wa.branch}\``);
    expect(prompt).toContain('based on `origin/release`');

    expect((await call('set_base_branch', { branch: 'origin/main' })).error).toMatch(/can't change now/);
    const { data: list } = await call('list_agents');
    expect(list).toMatchObject({ baseBranch: 'origin/release', featureBranch: home.branch, featureCheckout: home.path });
    expect(list.agents.find((x: { agentId: string }) => x.agentId === b.data.agentId)).toMatchObject({ branch: wb.branch, deliver: 'standalone', worktree: 'active' });

    // The orchestrator may read the feature branch's worktree (outside its cwd, so the harness asks), never change it.
    const ask = (tool: string, input: Record<string, unknown>) => ctx.orch.decide(parent, { requestId: 'q', tool, title: tool, input });
    expect(ask('Read', { file_path: join(home.path, 'app.txt') })).toMatchObject({ allow: true });
    expect(ask('Grep', { pattern: 'two', path: home.path })).toMatchObject({ allow: true });
    expect(ask('Glob', { pattern: '**/*.txt', path: join(home.path, 'src') })).toMatchObject({ allow: true });
    expect(ask('Write', { file_path: join(home.path, 'app.txt'), content: 'x' })).toMatchObject({ allow: false });
    expect(ask('Edit', { file_path: join(home.path, 'app.txt') })).toMatchObject({ allow: false });
    // A writer's own worktree is its business: the orchestrator reads that work once it is mustered.
    expect(ask('Read', { file_path: join(wa.path, 'app.txt') })).toMatchObject({ allow: false });
  });

  it('musters clean branches itself, hands a conflict to Muster, and believes git about the outcome', async () => {
    const hold = join(tmp('kelpie-hold-'), 'hold');
    onTestFinished(() => rmSync(hold, { force: true })); // a failure must not leave the harnesses held
    const ctx = setup({ FAKE_EVERY_TURN: '1', FAKE_HOLD_FILE: hold });
    const { parent, call } = await orchestrator(ctx, { model: 'opus', effort: 'high' });
    await call('set_base_branch', { branch: 'origin/main' });
    const ids: string[] = [];
    for (const title of ['API', 'Docs', 'Copy', 'Solo']) {
      const r = await call('spawn_agent', { title, task: `do ${title}`, writes: true, ...(title === 'Solo' ? { deliver: 'standalone' } : {}) });
      ids.push(r.data.agentId);
    }
    const [api, docs, copy, solo] = ids.map((id) => ctx.sessions.get(id)!);
    // Idle and reported (Kelpie has checkpointed their worktrees), so nothing else is running git there.
    await waitFor(() => ids.every((id) => ctx.store.getSession(id)!.notifiedIdx >= 0));
    // The agents' work: API and Copy both change line two; Docs adds a file; Copy leaves its change uncommitted.
    commit(api!.cwd, 'app.txt', 'one\nTWO (api)\nthree\n');
    commit(docs!.cwd, 'docs.txt', 'docs\n');
    writeFileSync(join(copy!.cwd, 'app.txt'), 'one\nTWO (copy)\nthree\n');

    expect((await call('muster_agents', { agentIds: [solo!.id] })).error).toMatch(/standalone/);
    // A sub-agent's session says whether its branch still waits to be mustered (the round-up's dot reads it), and says so again once it is.
    expect(api!.info()).toMatchObject({ branch: ctx.store.worktreeOf(api!.id)!.branch, worktree: 'active' });
    expect(solo!.info()).toMatchObject({ deliver: 'standalone' });
    const heard: string[] = [];
    const unwatch = ctx.sessions.watch((u) => u.type === 'session' && u.session.id === api!.id && heard.push(u.session.worktree ?? ''));
    writeFileSync(hold, ''); // Muster's turn waits on it, so Muster is surely still working when asked to muster again
    const { data, error } = await call('muster_agents', { agentIds: [api!.id, docs!.id, copy!.id], notes: 'API wins on line two' });
    unwatch();
    expect((await call('muster_agents', { agentIds: [copy!.id] })).error).toMatch(/Muster agent is already working/);
    rmSync(hold);
    expect(heard).toContain('mustered');
    expect(error).toBeUndefined();
    expect(data.merged).toEqual(['API', 'Docs']);
    expect(data.muster.branches).toEqual([ctx.store.worktreeOf(copy!.id)!.branch]);
    expect(data.muster.conflicts).toEqual(['app.txt']);

    const home = ctx.store.worktreeOf(parent.id)!;
    expect(git(home.path, 'log', '--merges', '--format=%s')).toContain('Muster: API');
    expect(git(home.path, 'show', 'HEAD:docs.txt')).toBe('docs');
    // Mustered: worktree and branch gone; Copy's uncommitted change was committed before the merge was tried.
    expect(ctx.store.worktreeOf(api!.id)).toMatchObject({ state: 'mustered' });
    expect(existsSync(api!.cwd)).toBe(false);
    expect(git(ctx.checkout, 'branch', '--list', ctx.store.worktreeOf(api!.id)!.branch)).toBe('');
    expect(git(copy!.cwd, 'status', '--porcelain')).toBe('');

    // Muster works in the feature branch's worktree with a brief naming what is left.
    const muster = ctx.sessions.get(data.muster.agentId)!;
    expect(muster).toMatchObject({ kind: 'muster', cwd: home.path, writes: true, browser: false });
    const musterArgv = await waitFor(() => jsonLines<string[]>(ctx.argsFile).find((a) => a.join(' ').includes("You are Muster, Kelpie's integrator")));
    // Even if the person has Claude in Chrome on by default: Muster never drives their browser.
    expect(musterArgv).toContain('--no-chrome');
    expect(musterArgv).not.toContain('--chrome');
    // On the round-up's model and effort, as spawned agents are.
    expect(muster).toMatchObject({ model: 'opus', effort: 'high' });
    expect(flag(musterArgv, '--model')).toEqual(['opus']);
    expect(flag(musterArgv, '--effort')).toEqual(['high']);
    const brief = ctx.store.firstSent(muster.id)!.text;
    expect(brief).toContain(ctx.store.worktreeOf(copy!.id)!.branch);
    expect(brief).toContain('API wins on line two');
    expect(brief).toContain('do Copy');

    // The fake Muster resolved nothing: the notification says so, from git.
    await waitFor(() => notes(parent).find((n) => n.includes('checked with git')));
    expect(notes(parent).find((n) => n.includes('checked with git'))).toContain('Still not mustered: Copy');
    // Resolve it as Muster would have, then let Muster report again: now Copy counts as mustered.
    git(home.path, 'merge', '-q', '--no-edit', '-X', 'ours', ctx.store.worktreeOf(copy!.id)!.branch);
    await call('message_agent', { agentId: muster.id, text: 'done?' });
    await waitFor(() => ctx.store.worktreeOf(copy!.id)!.state === 'mustered');
    expect(git(home.path, 'show', 'HEAD:app.txt')).toBe('one\nTWO (api)\nthree');
  });

  it('notifies with each writer’s branch, after committing what it left uncommitted', async () => {
    const ctx = setup({ FAKE_EVERY_TURN: '1' });
    const { parent, call } = await orchestrator(ctx);
    await call('set_base_branch', { branch: 'origin/main' });
    const { data } = await call('spawn_agent', { title: 'API', task: 'x', writes: true });
    const agent = ctx.sessions.get(data.agentId)!;
    await waitFor(() => ctx.store.getSession(agent.id)!.notifiedIdx >= 0);
    writeFileSync(join(agent.cwd, 'api.txt'), 'wip\n'); // left uncommitted after its turn
    await call('message_agent', { agentId: agent.id, text: 'one more thing' });
    const note = await waitFor(() => notes(parent).find((n) => n.includes('1 commit ahead')));
    expect(note).toContain(`Branch: ${ctx.store.worktreeOf(agent.id)!.branch} (1 commit ahead of the feature branch; 1 file changed`);
    expect(git(agent.cwd, 'log', '-1', '--format=%s')).toBe('kelpie: checkpoint (API)');
  });

  it('brings a swept worktree back at the same path when its agent is messaged, and resumes it there', async () => {
    const ctx = setup({ FAKE_EVERY_TURN: '1' });
    const { call } = await orchestrator(ctx);
    await call('set_base_branch', { branch: 'origin/main' });
    const { data } = await call('spawn_agent', { title: 'API', task: 'x', writes: true });
    const agent = ctx.sessions.get(data.agentId)!;
    await waitFor(() => idle(agent) && agent.info().harnessSessionId);
    await ctx.worktrees.remove(ctx.store.worktreeOf(agent.id)!);
    expect(existsSync(agent.cwd)).toBe(false);
    const starts = jsonLines(ctx.argsFile).length;
    await call('message_agent', { agentId: agent.id, text: 'carry on' });
    expect(existsSync(agent.cwd)).toBe(true);
    const argv = await waitFor(() => jsonLines<string[]>(ctx.argsFile)[starts]);
    expect(argv).toContain('--resume');
    expect(ctx.store.worktreeOf(agent.id)!.state).toBe('active');
  });

  it('brings back a swept feature branch worktree when the orchestrator lists its agents, so featureCheckout is there to read', async () => {
    const ctx = setup({ FAKE_EVERY_TURN: '1' });
    const { call } = await orchestrator(ctx);
    expect((await call('list_agents')).data.featureCheckout).toBeUndefined(); // no writer yet
    await call('set_base_branch', { branch: 'origin/main' });
    const { data } = await call('spawn_agent', { title: 'API', task: 'x', writes: true });
    const agent = ctx.sessions.get(data.agentId)!;
    await waitFor(() => idle(agent));
    const home = ctx.store.worktreeOf(agent.parentId!)!;
    await ctx.worktrees.remove(home);
    expect(existsSync(home.path)).toBe(false);
    const { data: list } = await call('list_agents');
    expect(list.featureCheckout).toBe(home.path);
    expect(existsSync(join(home.path, 'app.txt'))).toBe(true);
  });

  it("denies the orchestrator edits in Kelpie's worktrees and its repo by rule, in case settings allow them", async () => {
    const ctx = setup({ FAKE_HANG: '1' }, 6, true);
    const { parent, argv } = await orchestrator(ctx);
    const root = join(realpathSync(dirname(ctx.worktrees.root)), basename(ctx.worktrees.root)); // not made yet
    const cwd = realpathSync(ctx.checkout);
    expect(parent.scratch!.startsWith(cwd)).toBe(false);
    expect(flag(argv, '--disallowedTools')).toEqual([`Edit(/${cwd}/**)`, `Write(/${cwd}/**)`, `Edit(/${root}/**)`, `Write(/${root}/**)`]);
  });

  it('lists branches and takes a base branch over HTTP, fixed once a writer has started', async () => {
    const ctx = setup({ FAKE_HANG: '1' });
    const local = { host: '127.0.0.1:7317', 'content-type': 'application/json' };
    const branches = (await (await ctx.app.request('/api/repo/branches', { headers: local })).json()) as { branches: { name: string; remote: boolean }[] };
    expect(branches.branches[0]).toMatchObject({ remote: true });
    expect(branches.branches.map((b) => b.name)).toContain('my-local-thing');
    expect((await ctx.app.request(`/api/repo/branches?cwd=${encodeURIComponent(tmpdir())}`, { headers: local })).status).toBe(404);

    const res = await ctx.app.request('/api/sessions', { method: 'POST', headers: local, body: JSON.stringify({ baseBranch: 'origin/release' }) });
    const info = (await res.json()) as { id: string; baseBranch: string; baseCommit: string };
    expect(info).toMatchObject({ baseBranch: 'origin/release', baseCommit: ctx.release });
    expect((await ctx.app.request('/api/sessions', { method: 'POST', headers: local, body: JSON.stringify({ baseBranch: 'origin/nope' }) })).status).toBe(400);

    const parent = ctx.sessions.get(info.id)!;
    await ctx.orch.spawn(parent, { title: 'API', task: 'x', writes: true });
    const patch = await ctx.app.request(`/api/sessions/${info.id}`, { method: 'PATCH', headers: local, body: JSON.stringify({ baseBranch: 'origin/main' }) });
    expect(patch.status).toBe(409);
  });

  it('cleans up worktrees when the round-up is deleted, keeping branches with unmerged work', async () => {
    const ctx = setup({ FAKE_HANG: '1' });
    const { parent, call } = await orchestrator(ctx);
    await call('set_base_branch', { branch: 'origin/main' });
    const { data } = await call('spawn_agent', { title: 'API', task: 'x', writes: true });
    const wt = ctx.store.worktreeOf(data.agentId)!;
    writeFileSync(join(wt.path, 'api.txt'), 'work in progress\n');
    await ctx.sessions.delete(parent.id);
    expect(existsSync(wt.path)).toBe(false);
    expect(git(ctx.checkout, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(ctx.checkout, 'show', `${wt.branch}:api.txt`)).toBe('work in progress');
  });

  it('counts writers still being set up toward the agent limit', async () => {
    const ctx = setup({ FAKE_HANG: '1' }, 2);
    const { call } = await orchestrator(ctx);
    await call('set_base_branch', { branch: 'origin/main' });
    const results = await Promise.all(['A', 'B', 'C'].map((title) => call('spawn_agent', { title, task: 'x', writes: true })));
    expect(results.filter((r) => !r.error)).toHaveLength(2);
    expect(results.filter((r) => r.error).map((r) => r.error)).toEqual([expect.stringMatching(/2 agents are already working/)]);
  });

  it('never starts a writer the person stopped everything while its worktree was being made', async () => {
    const ctx = setup({ FAKE_EVERY_TURN: '1' });
    const { parent, call } = await orchestrator(ctx);
    await call('set_base_branch', { branch: 'origin/main' });
    const make = ctx.worktrees.createAgent.bind(ctx.worktrees);
    vi.spyOn(ctx.worktrees, 'createAgent').mockImplementation(async (...args) => {
      const row = await make(...args);
      await ctx.orch.stopAll(parent, { orchestrator: false });
      return row;
    });
    const { error } = await call('spawn_agent', { title: 'API', task: 'x', writes: true });
    expect(error).toBe(HALTED);
    // Nothing of it is left: no agent, and its worktree went with it.
    expect(ctx.sessions.children(parent.id)).toEqual([]);
    expect(ctx.store.worktreesOf(parent.id).filter((r) => r.kind === 'agent')).toEqual([]);
    expect(jsonLines<string[]>(ctx.argsFile)).toHaveLength(1); // only the orchestrator's own process ever started
  });

  it('starts no Muster once the person stopped everything while Kelpie merged, and says what is left', async () => {
    const ctx = setup({ FAKE_EVERY_TURN: '1' });
    const { parent, call } = await orchestrator(ctx);
    await call('set_base_branch', { branch: 'origin/main' });
    const a = (await call('spawn_agent', { title: 'A', task: 'x', writes: true })).data.agentId;
    const b = (await call('spawn_agent', { title: 'B', task: 'x', writes: true })).data.agentId;
    await waitFor(() => [a, b].every((id) => ctx.store.getSession(id)!.notifiedIdx >= 0));
    commit(ctx.sessions.get(a)!.cwd, 'app.txt', 'A\n');
    commit(ctx.sessions.get(b)!.cwd, 'app.txt', 'B\n');
    const merge = ctx.worktrees.merge.bind(ctx.worktrees);
    vi.spyOn(ctx.worktrees, 'merge').mockImplementation(async (...args) => {
      const result = await merge(...args);
      if (!result.ok) await ctx.orch.stopAll(parent, { orchestrator: false });
      return result;
    });
    const { data, error } = await call('muster_agents', { agentIds: [a, b] });
    expect(error).toBeUndefined();
    expect(data).toMatchObject({ merged: ['A'], waiting: { branches: [ctx.store.worktreeOf(b)!.branch], conflicts: ['app.txt'], reason: expect.stringContaining('stopped all agents') } });
    expect(ctx.sessions.children(parent.id).filter((c) => c.kind === 'muster')).toEqual([]);
  });

  it('says what it merged when it cannot start Muster for the rest, and refuses while the feature branch is in use', async () => {
    const ctx = setup({ FAKE_EVERY_TURN: '1' });
    const { parent, call } = await orchestrator(ctx);
    await call('set_base_branch', { branch: 'origin/main' });
    const a = (await call('spawn_agent', { title: 'A', task: 'x', writes: true })).data.agentId;
    const b = (await call('spawn_agent', { title: 'B', task: 'x', writes: true })).data.agentId;
    await waitFor(() => [a, b].every((id) => ctx.store.getSession(id)!.notifiedIdx >= 0));
    commit(ctx.sessions.get(a)!.cwd, 'app.txt', 'A\n');
    commit(ctx.sessions.get(b)!.cwd, 'app.txt', 'B\n');

    const inUse = vi.spyOn(ctx.orch as unknown as { inUse: () => boolean }, 'inUse').mockReturnValue(true);
    expect((await call('muster_agents', { agentIds: [a, b] })).error).toMatch(/working in the feature branch/);
    inUse.mockRestore();

    const cap = vi.spyOn(ctx.orch as unknown as { checkCap: () => void }, 'checkCap').mockImplementation(() => {
      throw new ToolError('4 agents are already working.');
    });
    const { data, error } = await call('muster_agents', { agentIds: [a, b] });
    expect(error).toBeUndefined();
    expect(data).toMatchObject({ merged: ['A'], waiting: { branches: [ctx.store.worktreeOf(b)!.branch], conflicts: ['app.txt'], reason: expect.stringContaining('already working') } });
    expect(ctx.store.worktreeOf(a)!.state).toBe('mustered');
    expect(git(ctx.store.worktreeOf(parent.id)!.path, 'status', '--porcelain')).toBe('');
    cap.mockRestore();
    // A's work is in the feature branch now: a reviewer looks there, not at a recreated empty worktree.
    expect((await call('spawn_agent', { title: 'Review A', task: 'x', writes: false, in: a })).error).toMatch(/mustered/);
  });

  it('commits a deleted agent’s work, removes its worktree, and keeps its branch', async () => {
    const ctx = setup({ FAKE_HANG: '1' });
    const { call } = await orchestrator(ctx);
    await call('set_base_branch', { branch: 'origin/main' });
    const { data } = await call('spawn_agent', { title: 'API', task: 'x', writes: true });
    const wt = ctx.store.worktreeOf(data.agentId)!;
    writeFileSync(join(wt.path, 'api.txt'), 'not yet committed\n');
    await ctx.sessions.delete(data.agentId);
    expect(existsSync(wt.path)).toBe(false);
    expect(git(ctx.checkout, 'show', `${wt.branch}:api.txt`)).toBe('not yet committed');
    expect(git(ctx.checkout, 'worktree', 'list')).not.toContain(wt.path);
  });

  it('keeps the base a writer started from, even if a change was fetching meanwhile', async () => {
    const ctx = setup({ FAKE_HANG: '1' });
    const { parent, call } = await orchestrator(ctx);
    await call('set_base_branch', { branch: 'origin/main' });
    const before = parent.baseCommit;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pin = ctx.worktrees.pinBase.bind(ctx.worktrees);
    vi.spyOn(ctx.worktrees, 'pinBase').mockImplementation(async (repo, branch) => {
      await gate;
      return pin(repo, branch);
    });
    const change = ctx.orch.setBase(parent, 'origin/release');
    expect((await call('spawn_agent', { title: 'API', task: 'x', writes: true })).error).toBeUndefined();
    release();
    await expect(change).rejects.toBeInstanceOf(BaseFixedError);
    expect(parent).toMatchObject({ baseBranch: 'origin/main', baseCommit: before });
  });

  it('checks a PATCH whole before saving any of it', async () => {
    const ctx = setup({ FAKE_HANG: '1' });
    const local = { host: '127.0.0.1:7317', 'content-type': 'application/json' };
    const { id } = (await (await ctx.app.request('/api/sessions', { method: 'POST', headers: local, body: '{}' })).json()) as { id: string };
    const patch = (body: unknown) => ctx.app.request(`/api/sessions/${id}`, { method: 'PATCH', headers: local, body: JSON.stringify(body) });
    expect((await patch({ baseBranch: 'origin/main', model: 'not valid' })).status).toBe(400);
    expect(ctx.sessions.get(id)!.baseBranch).toBeUndefined();
    expect((await patch({ baseBranch: 'origin/nope' })).status).toBe(400);
    expect((await patch({ baseBranch: 'origin/main', title: 'Checkout' })).status).toBe(200);
    expect(ctx.sessions.get(id)).toMatchObject({ baseBranch: 'origin/main', title: 'Checkout' });
  });
});
