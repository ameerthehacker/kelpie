import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '@kelpie/store';
import { Connections, createApp, GitHubConnector, githubEnv, Orchestrator, SessionManager, type ConnectionStatus, type RunGh } from '../src/index.js';

const FAKE = join(import.meta.dirname, '../../adapters/test/fake-claude.mjs');
const FIXTURE = join(import.meta.dirname, '../../adapters/fixtures/claude-code/plain.jsonl');
chmodSync(FAKE, 0o755);

const local = { host: '127.0.0.1:7317', 'content-type': 'application/json' };
const GH_TOKEN = 'gho_fromthecliaaaaaaaaaaaaaaaaaaaaaaa';
const PAT = 'ghp_pastedbythepersonbbbbbbbbbbbbbbbbbb';
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const jsonLines = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}

/** A gh CLI that is logged in with `token`, installed but logged out (null), or missing (undefined). */
function fakeGh(token: string | null | undefined): RunGh & { calls: string[][] } {
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (token === undefined) throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    if (token === null) throw Object.assign(new Error('no oauth token found for github.com'), { code: 1 });
    return `${token}\n`;
  };
  return Object.assign(gh, { calls });
}

/** The GitHub API's GET /user: who each known token is, with its scopes header (absent for fine-grained). */
function fakeGitHub(users: Record<string, { login: string; scopes?: string } | 'down'>) {
  const seen: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const token = auth.replace(/^(token|bearer) /i, '');
    seen.push(String(input));
    const user = users[token];
    if (user === 'down') throw new TypeError('fetch failed');
    if (!user) return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (user.scopes !== undefined) headers['x-oauth-scopes'] = user.scopes;
    const body = { login: user.login, name: 'Octo Cat', avatar_url: `https://avatars.example/${user.login}`, html_url: `https://github.com/${user.login}` };
    return new Response(JSON.stringify(body), { status: 200, headers });
  };
  return Object.assign(fetch as typeof globalThis.fetch, { seen });
}

function github(opts: { gh?: string | null; users?: Parameters<typeof fakeGitHub>[0]; store?: Store } = {}) {
  const store = opts.store ?? openStore(':memory:');
  const gh = fakeGh(opts.gh);
  const api = fakeGitHub(opts.users ?? {});
  return { store, gh, api, connector: new GitHubConnector({ store, gh, fetch: api }) };
}

describe('GitHub connector', () => {
  it('borrows the gh login: reads its token each time, stores nothing', async () => {
    const { connector, store, gh } = github({ gh: GH_TOKEN, users: { [GH_TOKEN]: { login: 'octo', scopes: 'gist, read:org, repo, workflow' } } });
    expect(await connector.check()).toMatchObject({
      connected: true,
      method: 'gh',
      account: { login: 'octo', name: 'Octo Cat', avatarUrl: 'https://avatars.example/octo', url: 'https://github.com/octo' },
      scopes: ['gist', 'read:org', 'repo', 'workflow'],
      cli: { name: 'gh', installed: true, loggedIn: true },
    });
    expect(store.getConnection('github')).toBeUndefined();
    expect(gh.calls[0]).toEqual(['auth', 'token', '--hostname', 'github.com']);
    expect((await connector.env()).GH_TOKEN).toBe(GH_TOKEN);
    expect(gh.calls).toHaveLength(2);
    // Nothing of Kelpie's to forget: gh manages its own login.
    await expect(connector.disconnect()).rejects.toThrow(/gh auth logout/);
  });

  it('says whether gh is missing or logged out, and is not connected', async () => {
    expect(await github({ gh: undefined }).connector.check()).toMatchObject({ connected: false, cli: { installed: false, loggedIn: false } });
    expect(await github({ gh: null }).connector.check()).toMatchObject({ connected: false, cli: { installed: true, loggedIn: false } });
    expect(await github({ gh: null }).connector.env()).toEqual({});
  });

  it('checks a pasted token with GitHub before storing it, and prefers it over gh', async () => {
    const { connector, store } = github({ gh: GH_TOKEN, users: { [GH_TOKEN]: { login: 'octo', scopes: 'repo' }, [PAT]: { login: 'other', scopes: 'repo, read:org' } } });
    await expect(connector.connect({ token: 'not a token' })).rejects.toThrow(/not a GitHub token/);
    await expect(connector.connect({ token: 'ghp_unknownccccccccccccccccccccccccccc' })).rejects.toThrow(/refused this token/);
    expect(store.getConnection('github')).toBeUndefined();

    expect(await connector.connect({ token: `  ${PAT}\n` })).toMatchObject({ connected: true, method: 'token', account: { login: 'other' }, scopes: ['repo', 'read:org'] });
    expect(store.getConnection('github')).toMatchObject({ method: 'token', secret: PAT, account: 'other', scopes: ['repo', 'read:org'] });
    expect((await connector.env()).GH_TOKEN).toBe(PAT);
    expect(await connector.check()).toMatchObject({ method: 'token', account: { login: 'other' } });

    // Forgetting it hands back to gh.
    expect(await connector.disconnect()).toMatchObject({ connected: true, method: 'gh', account: { login: 'octo' } });
    expect(store.getConnection('github')).toBeUndefined();
    expect((await connector.env()).GH_TOKEN).toBe(GH_TOKEN);
  });

  it('reports a fine-grained token as having no listed scopes', async () => {
    const { connector } = github({ gh: undefined, users: { [PAT]: { login: 'octo' } } });
    expect(await connector.connect({ token: PAT })).toMatchObject({ connected: true, scopes: null });
  });

  it('marks a stored token GitHub now refuses, and stops giving it to agents', async () => {
    const users: Parameters<typeof fakeGitHub>[0] = { [PAT]: { login: 'octo', scopes: 'repo' } };
    const { connector } = github({ gh: undefined, users });
    await connector.connect({ token: PAT });
    users[PAT] = 'down';
    // GitHub out of reach doesn't make the token wrong.
    expect(await connector.check()).toMatchObject({ connected: true, method: 'token', account: { login: 'octo' }, error: expect.stringMatching(/Couldn't reach GitHub/) });
    expect((await connector.env()).GH_TOKEN).toBe(PAT);
    delete users[PAT];
    expect(await connector.check()).toMatchObject({ connected: false, method: 'token', error: expect.stringMatching(/expired or revoked/) });
    expect(await connector.env()).toEqual({});
  });

  it('gives git a credential helper for github.com, after any git config the daemon already has', () => {
    expect(githubEnv('t', {})).toMatchObject({ GH_TOKEN: 't', GITHUB_TOKEN: 't', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.https://github.com.helper' });
    const env = githubEnv('t', { GIT_CONFIG_COUNT: '2' });
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'credential.https://github.com.helper' });
    // The helper reads the token from the env; it isn't written into the config.
    expect(env.GIT_CONFIG_VALUE_2).toContain('$GH_TOKEN');
    expect(env.GIT_CONFIG_VALUE_2).not.toContain('t;');
  });
});

describe('connections API', () => {
  function setup(opts: Parameters<typeof github>[0] = {}) {
    const gh = github(opts);
    const sessions = new SessionManager({ store: gh.store, defaultCwd: tmpdir() });
    const app = createApp(sessions, { connections: new Connections([gh.connector]) });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api/connections${path}`, { method, headers: local, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, text, json: JSON.parse(text) as ConnectionStatus & ConnectionStatus[] & { error?: string } };
    };
    return { ...gh, app, call };
  }

  it('connects, re-checks and disconnects GitHub, and never sends a token back', async () => {
    const { call, store } = setup({ gh: GH_TOKEN, users: { [GH_TOKEN]: { login: 'octo', scopes: 'repo' }, [PAT]: { login: 'other', scopes: 'repo' } } });
    const list = await call('GET', '');
    expect(list.status).toBe(200);
    expect(list.json).toEqual([expect.objectContaining({ id: 'github', name: 'GitHub', connected: true, method: 'gh' })]);

    const bad = await call('POST', '/github', { token: 'ghp_unknownccccccccccccccccccccccccccc' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/refused/);

    const added = await call('POST', '/github', { token: PAT });
    expect(added.status).toBe(200);
    expect(added.json).toMatchObject({ connected: true, method: 'token', account: { login: 'other' } });
    expect(store.getConnection('github')?.secret).toBe(PAT);

    const checked = await call('POST', '/github/check');
    expect(checked.json).toMatchObject({ method: 'token' });
    const again = await call('GET', '');
    const removed = await call('DELETE', '/github');
    expect(removed.json).toMatchObject({ method: 'gh' });
    expect((await call('DELETE', '/github')).status).toBe(400);

    for (const r of [list, bad, added, checked, again, removed]) {
      expect(r.text).not.toContain(PAT);
      expect(r.text).not.toContain(GH_TOKEN);
    }
  });

  it('answers an unknown connector with 404, and only local pages', async () => {
    const { app, call } = setup();
    expect((await call('POST', '/gitlab', { token: PAT })).status).toBe(404);
    expect((await call('POST', '/gitlab/check')).status).toBe(404);
    const foreign = await app.request('/api/connections/github', { method: 'POST', headers: { ...local, origin: 'https://evil.example' }, body: JSON.stringify({ token: PAT }) });
    expect(foreign.status).toBe(403);
  });
});

describe('agents get the connection', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.stopAll()));
  });

  it('starts the orchestrator and its agents with GH_TOKEN and GITHUB_TOKEN, read fresh for each start', async () => {
    const envFile = join(tmp('kelpie-env-'), 'env.jsonl');
    const { store, connector } = github({ gh: GH_TOKEN, users: { [PAT]: { login: 'octo', scopes: 'repo' } } });
    const orch = new Orchestrator({ store, mcpUrl: 'http://127.0.0.1:7317/mcp', connections: new Connections([connector]) });
    const runsDir = tmp('kelpie-runs-');
    const sessions = new SessionManager({
      store,
      defaultCwd: tmpdir(),
      runsDir,
      defaults: { bin: FAKE, env: { FAKE_FIXTURE: FIXTURE, FAKE_ENV_FILE: envFile } },
      hooks: orch,
    });
    orch.attach(sessions);
    managers.push(sessions);

    const parent = sessions.create();
    await parent.send('Do the things');
    expect(await waitFor(() => jsonLines(envFile)[0])).toEqual({ GH_TOKEN, GITHUB_TOKEN: GH_TOKEN });

    // A token pasted since is what the next agent gets.
    await connector.connect({ token: PAT });
    const agent = sessions.create(tmpdir(), { parentId: parent.id, role: 'agent', title: 'A' });
    await agent.send('Look around');
    expect(await waitFor(() => jsonLines(envFile)[1])).toEqual({ GH_TOKEN: PAT, GITHUB_TOKEN: PAT });

    // Nor in the runs' records of how they started, nor their logs.
    await waitFor(() => !agent.working && agent.lastTurn);
    for (const run of readdirSync(runsDir)) {
      for (const file of ['run.json', 'raw.jsonl']) expect(readFileSync(join(runsDir, run, file), 'utf8')).not.toMatch(new RegExp(`${PAT}|${GH_TOKEN}`));
    }
    expect(JSON.stringify([...parent.events(), ...agent.events()])).not.toContain(PAT);
  });
});
