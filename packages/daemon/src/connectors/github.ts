import { execFile } from 'node:child_process';
import { Octokit } from '@octokit/rest';
import type { Store } from '@kelpie/store';
import { ConnectError, type ConnectionAccount, type ConnectionStatus, type Connector } from './connector.js';

/** Runs the gh CLI and resolves with its stdout; rejects as execFile does (`code: 'ENOENT'` when it isn't installed). */
export type RunGh = (args: string[]) => Promise<string>;

const runGh: RunGh = (args) =>
  new Promise((ok, fail) =>
    execFile('gh', args, { timeout: 10_000, killSignal: 'SIGKILL', env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout) => (err ? fail(err) : ok(stdout))),
  );

/** GitHub tokens (ghp_…, gho_…, github_pat_…) are letters, digits and underscores. */
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;
const REFUSED = 'GitHub refused this token: it is wrong, expired or revoked.';

export interface GitHubOptions {
  store: Store;
  /** Runs the gh CLI; tests pass a fake. */
  gh?: RunGh;
  /** The GitHub API's fetch; tests pass a fake. */
  fetch?: typeof fetch;
}

type LookUp = { account: ConnectionAccount; scopes: string[] | null } | { error: string; refused: boolean };

/**
 * The env that lets an agent's `gh` and `git` (over HTTPS) act as the person on GitHub. Git gets a
 * credential helper for github.com through GIT_CONFIG_* (after any the daemon was given), which
 * answers with $GH_TOKEN, so the token is in no config file.
 */
export function githubEnv(token: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const n = Number(base.GIT_CONFIG_COUNT) || 0;
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${n}`]: '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f',
  };
}

/**
 * GitHub, through the person's own `gh` login when there is one (its token is read from gh each
 * time, never copied), or a personal access token they pasted, which Kelpie stores. A stored token
 * wins: the person chose it over gh. Disconnecting forgets it, and gh's login takes over again.
 */
export class GitHubConnector implements Connector {
  readonly id = 'github';
  readonly name = 'GitHub';
  private readonly store: Store;
  private readonly gh: RunGh;
  private readonly fetch: typeof fetch | undefined;
  /** A stored token GitHub refused: agents don't get it until it is replaced. */
  private refused: string | undefined;

  constructor(opts: GitHubOptions) {
    this.store = opts.store;
    this.gh = opts.gh ?? runGh;
    this.fetch = opts.fetch;
  }

  async check(): Promise<ConnectionStatus> {
    const stored = this.store.getConnection(this.id);
    const cli = await this.ghLogin();
    const base = { id: this.id, name: this.name, cli: { name: 'gh', installed: cli.installed, loggedIn: !!cli.token }, checkedAt: Date.now() };
    const token = stored?.secret ?? cli.token;
    if (!token) return { ...base, connected: false };
    const method = stored ? 'token' : 'gh';
    const found = await this.lookUp(token);
    if ('account' in found) {
      if (stored) {
        this.refused = undefined;
        this.store.setConnection({ ...stored, account: found.account.login, scopes: found.scopes });
      }
      return { ...base, connected: true, method, ...found };
    }
    if (stored && found.refused) this.refused = stored.secret;
    const error = !stored && found.refused ? 'GitHub refused the token gh has: run `gh auth login` again.' : found.error;
    // A failure to reach GitHub doesn't make the credential wrong: it stays connected, with the error.
    return {
      ...base,
      connected: !found.refused,
      method,
      ...(stored?.account ? { account: { login: stored.account }, scopes: stored.scopes } : {}),
      error,
    };
  }

  async connect(input: { token?: unknown }): Promise<ConnectionStatus> {
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (!TOKEN.test(token)) throw new ConnectError('That is not a GitHub token: paste one that starts with ghp_ or github_pat_.');
    const [found, cli] = await Promise.all([this.lookUp(token), this.ghLogin()]);
    if (!('account' in found)) throw new ConnectError(found.error);
    this.store.setConnection({ provider: this.id, method: 'token', secret: token, account: found.account.login, scopes: found.scopes });
    this.refused = undefined;
    return {
      id: this.id,
      name: this.name,
      connected: true,
      method: 'token',
      ...found,
      cli: { name: 'gh', installed: cli.installed, loggedIn: !!cli.token },
      checkedAt: Date.now(),
    };
  }

  async disconnect(): Promise<ConnectionStatus> {
    if (!this.store.deleteConnection(this.id)) throw new ConnectError("Kelpie has no token of yours to forget. A login it borrows from gh is gh's: sign out with `gh auth logout`.");
    this.refused = undefined;
    return this.check();
  }

  async env(): Promise<Record<string, string>> {
    const stored = this.store.getConnection(this.id);
    const token = stored ? (stored.secret === this.refused ? undefined : stored.secret) : (await this.ghLogin()).token;
    return token ? githubEnv(token) : {};
  }

  /** Whether gh is installed, and the token it is logged in with on github.com. */
  private async ghLogin(): Promise<{ installed: boolean; token?: string }> {
    try {
      const token = (await this.gh(['auth', 'token', '--hostname', 'github.com'])).trim();
      return { installed: true, ...(token ? { token } : {}) };
    } catch (err) {
      return { installed: (err as NodeJS.ErrnoException).code !== 'ENOENT' };
    }
  }

  /** Who a token belongs to, and its scopes (classic and OAuth tokens list them; fine-grained ones don't). */
  private async lookUp(token: string): Promise<LookUp> {
    const octokit = new Octokit({ auth: token, userAgent: 'kelpie', request: { ...(this.fetch ? { fetch: this.fetch } : {}), signal: AbortSignal.timeout(10_000) } });
    try {
      const { data, headers } = await octokit.rest.users.getAuthenticated();
      const header = headers['x-oauth-scopes'];
      return {
        account: { login: data.login, ...(data.name ? { name: data.name } : {}), avatarUrl: data.avatar_url, url: data.html_url },
        scopes: typeof header === 'string' ? header.split(',').map((s) => s.trim()).filter(Boolean) : null,
      };
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (status === 401) return { error: REFUSED, refused: true };
      // E.g. a rate limit, or an organization's SSO: the token may be fine.
      if (status === 403) return { error: `GitHub won't take this token right now: ${(err as Error).message}`, refused: false };
      return { error: `Couldn't reach GitHub to check the token (${(err as Error).message}).`, refused: false };
    }
  }
}
