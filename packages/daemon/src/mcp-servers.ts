import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { grantKey, type McpGrant, type McpScope, type McpServerInfo, type McpServerList, type McpStatus } from '@kelpie/protocol';

type Obj = Record<string, any>;

export type { McpGrant, McpScope, McpServerInfo, McpServerList, McpStatus };

/** One of the person's servers as Kelpie would hand it to an agent: its entry as written, secrets and all. Never sent to the UI. */
interface Found {
  name: string;
  scope: McpScope;
  /** For project and local servers: the directory they are configured for. */
  repo?: string;
  config: Obj;
}

export interface McpServersOptions {
  /** Claude Code's own config file; default `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json`. */
  claudeJson?: string;
  /** The `claude` binary the check runs. */
  bin?: string;
  /** How long the check waits for servers to connect. Default 15 s. */
  timeoutMs?: number;
  /** How many checks may run at once (each starts Claude Code and the person's servers). Default 2. */
  maxChecks?: number;
  /** How soon a failed check may be tried again before agents start. Default 30 s. */
  retryMs?: number;
  /** Env for the check (tests). */
  env?: Record<string, string>;
}

/**
 * How Claude Code 2.1.308 writes a server's name in its tools' names (`mcp__<this>__<tool>`) and
 * matches it in rules, as its bundled source does: anything but letters, digits, `_` and `-` becomes
 * `_`; for a claude.ai connector's name, runs of `_` then collapse and the ends are trimmed.
 * `claude.ai Atlassian - Jira` is `claude_ai_Atlassian_-_Jira`, `claude.ai My  Docs` is `claude_ai_My_Docs`.
 */
export function mcpToolPrefix(name: string): string {
  const out = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return name.startsWith('claude.ai ') ? out.replace(/_+/g, '_').replace(/^_|_$/g, '') : out;
}

/** The ask rule that covers every tool of a server: Claude Code matches it on the name's first `__` part, so names with `__` are never given. */
export const askRule = (name: string): string => `mcp__${mcpToolPrefix(name)}`;

/** A name as Claude Code compares lookalikes (lowercase, `-` and `_` runs as one `_`): `Kelpie-2` is `kelpie_2`. */
const canonical = (name: string) =>
  mcpToolPrefix(name)
    .toLowerCase()
    .replace(/[-_]+/g, '_')
    .replace(/^_|_$/g, '');

/** Names of Kelpie's own servers: a server named like one would have its tools pass for theirs (and Kelpie allows its own without asking). */
export const RESERVED_MCP = ['kelpie', 'claude_in_chrome'];

/**
 * Why agents can't have a server of this name, if they can't: its tools' names would be read as
 * another server's. A `__` splits a tool name where Claude Code doesn't expect it; Kelpie's own
 * names (and lookalikes, `Kelpie-x`, `kelpie.2`) are its server's and the browser's; and only a
 * claude.ai connector may be named like one.
 */
export function blockedReason(name: string, scope: McpScope): string | undefined {
  const prefix = mcpToolPrefix(name);
  if (!/[a-zA-Z0-9]/.test(prefix)) return 'Its name has no letters or digits Claude Code keeps, so its tools would have no name of their own.';
  if (prefix.includes('__')) return `Its name has “__” in it as Claude Code writes it (${prefix}), which would make its tools look like another server's. Rename it in Claude Code to use it.`;
  const c = canonical(name);
  const own = RESERVED_MCP.find((r) => c === r || c.startsWith(`${r}_`));
  if (own) return `Its name is too close to Kelpie's own ${own === 'kelpie' ? 'server' : 'browser tools'} (“${own.replaceAll('_', '-')}”), whose tools agents use without asking. Rename it in Claude Code to use it.`;
  if (scope !== 'claudeai' && (c.startsWith('claude_ai_') || c.startsWith('claudeai_'))) return "Its name looks like a claude.ai connector's, but it isn't one. Rename it in Claude Code to use it.";
  return undefined;
}

/**
 * What a server runs or reaches, as a short hash: its type and command and arguments, or its URL
 * (and a connector's id). Not its env or headers, so a rotated token keeps it allowed; a new
 * command or URL does not.
 */
export function fingerprint(scope: McpScope, config: Obj): string {
  const what = scope === 'claudeai' ? [config.url, config.id] : [config.type ?? null, config.command ?? null, config.args ?? null, config.url ?? null];
  return createHash('sha256').update(JSON.stringify(what)).digest('hex').slice(0, 16);
}

/** An empty list this long after start is taken as none (before then the CLI may still be reading its config). */
const EMPTY_AFTER_MS = 4000;

/** Scopes from weakest to strongest: of two allowed servers with one name, an agent gets the stronger, as in Claude Code. */
const PRECEDENCE: McpScope[] = ['claudeai', 'user', 'project', 'local'];

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** A JSON file's contents; undefined if it is missing or unreadable (Claude Code may be mid-write). */
function readJson(path: string): Obj | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const json: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isObj(json) ? json : undefined;
  } catch {
    // Not the parser's message: it quotes the file around the error, which may be a token.
    console.warn(`kelpie: could not read MCP servers from ${path}: not valid JSON`);
    return undefined;
  }
}

const entries = (servers: unknown): [string, Obj][] => (isObj(servers) ? Object.entries(servers).filter((e): e is [string, Obj] => isObj(e[1])) : []);

/** The git repository `dir` is in, if any: where `.mcp.json` files stop being looked for. */
function repoRoot(dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return undefined;
  }
}

/** `dir` and the directories above it up to its repo root, nearest first. */
function upToRoot(dir: string): string[] {
  const root = repoRoot(dir);
  const dirs: string[] = [];
  for (let d = dir; ; d = dirname(d)) {
    dirs.push(d);
    if (d === root || !root || dirname(d) === d) return dirs;
  }
}

/** A server's transport, as the UI shows it. */
function typeOf(config: Obj, scope: McpScope): string {
  if (scope === 'claudeai') return 'connector';
  if (typeof config.type === 'string') return config.type;
  return typeof config.command === 'string' ? 'stdio' : 'unknown';
}

/** Claude Code's word for a server's state (mcp_status), as the UI's. */
function statusOf(s: unknown): McpStatus {
  if (s === 'connected') return 'connected';
  if (s === 'needs-auth') return 'needs-auth';
  if (s === 'pending') return 'pending';
  return 'failed';
}

const keyOf = (s: Pick<Found, 'scope' | 'name' | 'repo'>) => grantKey(s);

/** What Claude Code reported of a server: its name, scope and state, and a connector's entry (no secrets: the account signs it in). */
interface Probed {
  name: string;
  scope: string;
  status: McpStatus;
  config: Obj;
}

interface Check {
  at: number;
  probed: Probed[];
  error?: string;
}

/**
 * The person's own MCP servers, which agents may get once they turn it on in Settings and allow
 * each one. Config files are read afresh each time (their entries go nowhere but an agent's private
 * config file); claude.ai connectors, and whether servers connect, come from asking Claude Code
 * itself, which is slow (it starts them), so that answer is kept until asked for again.
 */
export class McpServers {
  private readonly claudeJson: string;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly maxChecks: number;
  private readonly retryMs: number;
  private readonly env: Record<string, string> | undefined;
  /** Claude Code's last answer per directory. */
  private readonly checks = new Map<string, Check>();
  /** Checks under way per directory, shared. */
  private readonly running = new Map<string, Promise<void>>();
  /** Checks waiting for one of the `maxChecks` places. */
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly warned = new Set<string>();

  constructor(opts: McpServersOptions = {}) {
    this.claudeJson = opts.claudeJson ?? join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
    this.bin = opts.bin ?? 'claude';
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxChecks = opts.maxChecks ?? 2;
    this.retryMs = opts.retryMs ?? 30_000;
    this.env = opts.env;
  }

  /** The servers for round-ups in `repo`, as last checked: reading them starts nothing. */
  list(repo: string): Omit<McpServerList, 'repos'> {
    const dir = resolve(repo);
    const check = this.checks.get(dir);
    // Claude Code's word on each server it loads, by scope and name.
    const probed = new Map((check?.probed ?? []).map((p) => [`${p.scope}\0${p.name}`, p.status]));
    const servers = this.found(dir).map((s): McpServerInfo => {
      const blocked = blockedReason(s.name, s.scope);
      return {
        name: s.name,
        type: typeOf(s.config, s.scope),
        scope: s.scope,
        ...(s.repo ? { repo: s.repo } : {}),
        fingerprint: fingerprint(s.scope, s.config),
        // Kelpie doesn't start a repo's own servers to check them.
        status: s.scope === 'project' ? 'unchecked' : (probed.get(`${s.scope}\0${s.name}`) ?? 'unchecked'),
        ...(blocked ? { blocked } : {}),
      };
    });
    return { repo: dir, servers, ...(check ? { checkedAt: new Date(check.at).toISOString() } : {}), ...(check?.error ? { error: check.error } : {}) };
  }

  /** Asks Claude Code again about `repo` (its connectors, and whether servers connect). */
  async refresh(repo: string): Promise<Omit<McpServerList, 'repos'>> {
    const dir = resolve(repo);
    await this.check(dir);
    return this.list(dir);
  }

  /**
   * Before agents in `repo` start: asks Claude Code if an allowed connector's entry isn't known yet
   * (only it has them), or the last check failed a while ago.
   */
  async ensure(repo: string, grants: readonly McpGrant[]): Promise<void> {
    if (!grants.some((g) => g.scope === 'claudeai')) return;
    const dir = resolve(repo);
    const check = this.checks.get(dir);
    if (!check || (check.error && Date.now() - check.at >= this.retryMs)) await this.check(dir);
  }

  /**
   * The `mcpServers` map for an agent working for a round-up in `repo`: each server whose grant
   * matches it exactly (scope, repo, name and fingerprint), and the names left out with why.
   */
  forAgents(repo: string, grants: readonly McpGrant[]): { servers: Record<string, Obj>; skipped: { name: string; reason: string }[] } {
    const granted = new Map(grants.map((g) => [keyOf(g), g.fingerprint]));
    const servers: Record<string, Obj> = {};
    const prefixes = new Map<string, string>();
    const skipped: { name: string; reason: string }[] = [];
    // Strongest first, so of two allowed servers with one name the one Claude Code would load wins.
    const found = this.found(resolve(repo)).sort((a, b) => PRECEDENCE.indexOf(b.scope) - PRECEDENCE.indexOf(a.scope));
    for (const s of found) {
      const fp = granted.get(keyOf(s));
      if (fp === undefined) continue;
      const blocked = blockedReason(s.name, s.scope);
      const prefix = mcpToolPrefix(s.name);
      if (fp !== fingerprint(s.scope, s.config)) skipped.push({ name: s.name, reason: 'its command or URL changed since it was allowed' });
      else if (blocked) skipped.push({ name: s.name, reason: blocked });
      else if (s.name in servers) skipped.push({ name: s.name, reason: `a ${s.scope} server of that name is allowed too, and the other one wins` });
      else if (prefixes.has(prefix)) skipped.push({ name: s.name, reason: `its tools would have the same names as ${prefixes.get(prefix)}'s` });
      else {
        servers[s.name] = s.config;
        prefixes.set(prefix, s.name);
      }
    }
    return { servers, skipped };
  }

  /** Logs once per server and reason. */
  warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    console.warn(message);
  }

  /**
   * The servers Claude Code would see in `dir`, each where it is configured: connectors from the
   * last check, user ones from ~/.claude.json, project ones from the nearest `.mcp.json` naming
   * them (from `dir` up to its repo root), local ones from ~/.claude.json's entry for `dir` or its
   * repo (`dir`'s winning). A name in two scopes is listed for each: never one for the other.
   */
  private found(dir: string): Found[] {
    const claude = readJson(this.claudeJson);
    const found: Found[] = [];
    for (const p of this.checks.get(dir)?.probed ?? []) if (p.scope === 'claudeai') found.push({ name: p.name, scope: 'claudeai', config: p.config });
    for (const [name, config] of entries(claude?.mcpServers)) found.push({ name, scope: 'user', config });
    const seen = new Set<string>();
    for (const d of upToRoot(dir)) {
      for (const [name, config] of entries(readJson(join(d, '.mcp.json'))?.mcpServers)) {
        if (!seen.has(name)) found.push({ name, scope: 'project', repo: d, config });
        seen.add(name);
      }
    }
    const projects = isObj(claude?.projects) ? claude.projects : {};
    const local = new Set<string>();
    for (const p of [...new Set([dir, repoRoot(dir)])]) {
      if (!p) continue;
      for (const [name, config] of entries(projects[p]?.mcpServers)) {
        if (!local.has(name)) found.push({ name, scope: 'local', repo: p, config });
        local.add(name);
      }
    }
    return found.sort((a, b) => PRECEDENCE.indexOf(a.scope) - PRECEDENCE.indexOf(b.scope) || a.name.localeCompare(b.name));
  }

  private check(dir: string): Promise<void> {
    let run = this.running.get(dir);
    if (!run) {
      run = this.slot()
        .then(() => this.probe(dir))
        .then(
          (probed) => void this.checks.set(dir, { at: Date.now(), probed }),
          (err: Error) => void this.checks.set(dir, { at: Date.now(), probed: this.checks.get(dir)?.probed ?? [], error: err.message }),
        )
        .finally(() => {
          this.running.delete(dir);
          this.active--;
          this.queue.shift()?.();
        });
      this.running.set(dir, run);
    }
    return run;
  }

  /** Waits for one of the `maxChecks` places. */
  private slot(): Promise<void> {
    if (this.active < this.maxChecks) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((go) =>
      this.queue.push(() => {
        this.active++;
        go();
      }),
    );
  }

  /**
   * Asks Claude Code which servers it loads in `dir` and how they are (its `mcp_status` control
   * request), with no turn sent, so no model is called. The repo's own `.mcp.json` servers are
   * turned off for it: Kelpie must not run a cloned repo's commands just to list them.
   */
  private probe(dir: string): Promise<Probed[]> {
    const project = new Set<string>();
    for (const d of upToRoot(dir)) for (const [name] of entries(readJson(join(d, '.mcp.json'))?.mcpServers)) project.add(name);
    const settings = JSON.stringify({ enableAllProjectMcpServers: false, disabledMcpjsonServers: [...project] });
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default', '--tools', 'Read', '--no-chrome', '--settings', settings];
    return new Promise((done, fail) => {
      const child = spawn(this.bin, args, { cwd: dir, env: { ...process.env, ...this.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      const started = Date.now();
      let n = 0;
      let settled = false;
      let again: ReturnType<typeof setTimeout> | undefined;
      let last: Probed[] = [];
      const finish = (err: Error | undefined, probed?: Probed[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(again);
        child.kill();
        if (err) fail(err);
        else done(probed ?? []);
      };
      const ask = () => child.stdin.write(JSON.stringify({ type: 'control_request', request_id: `mcp-${++n}`, request: { subtype: 'mcp_status' } }) + '\n');
      // Servers still connecting when time is up are reported as they are.
      const timer = setTimeout(() => (last.length ? finish(undefined, last) : finish(new Error('Claude Code did not answer in time'))), this.timeoutMs);
      child.on('error', (err) => finish(new Error(`could not run ${this.bin}: ${err.message}`)));
      child.on('close', (code) => finish(new Error(`Claude Code exited (${code}) before listing its MCP servers`)));
      child.stdin.on('error', () => {});
      createInterface({ input: child.stdout }).on('line', (line) => {
        let o: Obj;
        try {
          o = JSON.parse(line) as Obj;
        } catch {
          return;
        }
        if (o.type !== 'control_response') return;
        const servers: unknown = o.response?.response?.mcpServers;
        if (!Array.isArray(servers)) return finish(new Error(o.response?.error ? String(o.response.error) : 'Claude Code gave no MCP server list'));
        last = servers.filter(isObj).flatMap((s): Probed[] => {
          const p = { name: String(s.name), scope: String(s.scope ?? ''), status: statusOf(s.status), config: {} };
          if (s.scope !== 'claudeai') return [p];
          // Only a connector's entry is kept (its type, URL and id: the account signs it in); without them no agent could load it.
          const c = isObj(s.config) ? s.config : {};
          if (typeof c.type !== 'string' || typeof c.url !== 'string' || typeof c.id !== 'string') {
            this.warnOnce(`kelpie: Claude Code listed the connector "${p.name}" without its URL or id; agents can't be given it`);
            return [];
          }
          return [{ ...p, config: { type: c.type, url: c.url, id: c.id } }];
        });
        // Right after start it may not have loaded its config yet (an empty list), or be still connecting.
        const loading = !last.length && Date.now() - started < EMPTY_AFTER_MS;
        if (loading || last.some((s) => s.status === 'pending')) again = setTimeout(ask, n < 4 ? 250 : 500);
        else finish(undefined, last);
      });
      ask();
    });
  }
}

