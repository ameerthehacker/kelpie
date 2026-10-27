import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { McpScope, McpServerInfo, McpServerList, McpStatus } from '@kelpie/protocol';

type Obj = Record<string, any>;

export type { McpScope, McpServerInfo, McpServerList, McpStatus };

/** A server as Kelpie would hand it to an agent: its entry as written, secrets and all. Never sent to the UI. */
interface Found {
  name: string;
  scope: McpScope;
  config: Obj;
}

export interface McpServersOptions {
  /** Claude Code's own config file; default `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json`. */
  claudeJson?: string;
  /** The `claude` binary the check runs. */
  bin?: string;
  /** How long the check waits for servers to connect. Default 15 s. */
  timeoutMs?: number;
  /** Env for the check (tests). */
  env?: Record<string, string>;
}

/** Names Kelpie's own MCP servers use: one of the person's by that name would pass as Kelpie's (and be allowed by its rule). */
export const RESERVED_MCP = ['kelpie', 'claude-in-chrome'];

/**
 * How Claude Code writes a server's name in its tools' names (`mcp__<this>__<tool>`) and rules:
 * `claude.ai Claude Docs` is `claude_ai_Claude_Docs`.
 */
export const mcpToolPrefix = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_');

/** Why agents can't have a server of this name, if they can't. */
export function blockedReason(name: string): string | undefined {
  const own = RESERVED_MCP.find((r) => r === mcpToolPrefix(name));
  return own ? `Kelpie's own ${own === 'kelpie' ? 'server' : 'browser tools'} use the name “${own}”, so agents can't have this one. Rename it in Claude Code to use it.` : undefined;
}

/** An empty list this long after start is taken as none (before then the CLI may still be reading its config). */
const EMPTY_AFTER_MS = 4000;

/** Scopes from weakest to strongest: a server's name in a later one hides it in the earlier ones, as in Claude Code. */
const PRECEDENCE: McpScope[] = ['claudeai', 'user', 'project', 'local'];

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** A JSON file's contents; undefined if it is missing or unreadable (Claude Code may be mid-write). */
function readJson(path: string): Obj | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const json: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isObj(json) ? json : undefined;
  } catch (err) {
    console.warn(`kelpie: could not read MCP servers from ${path}: ${(err as Error).message}`);
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

/** What Claude Code reported of a server: its name, scope and state, and a connector's entry (no secrets: the account signs it in). */
interface Probed {
  name: string;
  scope: string;
  status: McpStatus;
  config: Obj;
}

/**
 * The person's own MCP servers, which agents may get once they turn it on in Settings. Config
 * files are read afresh each time (never sent anywhere but to an agent's private config file);
 * claude.ai connectors, and whether servers connect, come from asking Claude Code itself, which is
 * slow (it starts them), so that answer is kept until the person asks again.
 */
export class McpServers {
  private readonly claudeJson: string;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly env: Record<string, string> | undefined;
  /** Claude Code's last answer per directory. */
  private readonly checks = new Map<string, { at: string; probed: Probed[]; error?: string }>();
  /** Checks under way per directory, shared. */
  private readonly running = new Map<string, Promise<void>>();

  constructor(opts: McpServersOptions = {}) {
    this.claudeJson = opts.claudeJson ?? join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
    this.bin = opts.bin ?? 'claude';
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.env = opts.env;
  }

  /** The servers for round-ups in `cwd`, checked with Claude Code (once, or again with `refresh`). */
  async list(cwd: string, refresh = false): Promise<McpServerList> {
    const dir = resolve(cwd);
    if (refresh || !this.checks.has(dir)) await this.check(dir);
    return this.listed(dir);
  }

  /**
   * Before agents in `cwd` start: asks Claude Code once, if an allowed server isn't in the config
   * files (a claude.ai connector, whose entry only Claude Code has).
   */
  async ensure(cwd: string, allow: readonly string[]): Promise<void> {
    const dir = resolve(cwd);
    if (this.checks.has(dir)) return;
    const inFiles = new Set(this.found(dir).map((s) => s.name));
    if (allow.some((name) => !inFiles.has(name))) await this.check(dir);
  }

  /**
   * The `mcpServers` map for an agent working for a round-up in `cwd`: the allowed servers as
   * Claude Code would load them there, and the names left out because they are Kelpie's own.
   */
  forAgents(cwd: string, allow: readonly string[]): { servers: Record<string, Obj>; blocked: string[] } {
    const allowed = new Set(allow);
    const servers: Record<string, Obj> = {};
    const blocked: string[] = [];
    for (const s of this.found(resolve(cwd))) {
      if (!allowed.has(s.name)) continue;
      if (blockedReason(s.name)) blocked.push(s.name);
      else servers[s.name] = s.config;
    }
    return { servers, blocked };
  }

  /** The servers as the UI sees them: what is in the config files, with Claude Code's word on each. */
  private listed(dir: string): McpServerList {
    const check = this.checks.get(dir);
    const probed = new Map((check?.probed ?? []).map((p) => [p.name, p]));
    const servers = this.found(dir).map((s): McpServerInfo => {
      const blocked = blockedReason(s.name);
      return {
        name: s.name,
        type: typeOf(s.config, s.scope),
        scope: s.scope,
        status: s.scope === 'project' ? 'unchecked' : (probed.get(s.name)?.status ?? 'unchecked'),
        ...(blocked ? { blocked } : {}),
      };
    });
    return { cwd: dir, servers, ...(check ? { checkedAt: check.at } : {}), ...(check?.error ? { error: check.error } : {}) };
  }

  /**
   * The servers Claude Code would load in `dir`, one per name: connectors from its last check,
   * user ones from ~/.claude.json, project ones from `.mcp.json` files from `dir` up to its repo
   * root (nearer ones win), and local ones from ~/.claude.json's entry for `dir` or its repo.
   */
  private found(dir: string): Found[] {
    const root = repoRoot(dir);
    const claude = readJson(this.claudeJson);
    const found: Found[] = (this.checks.get(dir)?.probed ?? []).filter((p) => p.scope === 'claudeai').map((p) => ({ name: p.name, scope: 'claudeai', config: p.config }));
    for (const [name, config] of entries(claude?.mcpServers)) found.push({ name, scope: 'user', config });
    // Outermost first, so a nearer file's server replaces it below.
    const dirs: string[] = [];
    for (let d = dir; ; d = dirname(d)) {
      dirs.unshift(d);
      if (d === root || !root || dirname(d) === d) break;
    }
    for (const d of dirs) for (const [name, config] of entries(readJson(join(d, '.mcp.json'))?.mcpServers)) found.push({ name, scope: 'project', config });
    const projects = isObj(claude?.projects) ? claude.projects : {};
    for (const p of [...new Set([root, dir])]) {
      if (p) for (const [name, config] of entries(projects[p]?.mcpServers)) found.push({ name, scope: 'local', config });
    }
    const byName = new Map<string, Found>();
    for (const s of found.sort((a, b) => PRECEDENCE.indexOf(a.scope) - PRECEDENCE.indexOf(b.scope))) byName.set(s.name, s);
    return [...byName.values()].sort((a, b) => PRECEDENCE.indexOf(a.scope) - PRECEDENCE.indexOf(b.scope) || a.name.localeCompare(b.name));
  }

  private check(dir: string): Promise<void> {
    let run = this.running.get(dir);
    if (!run) {
      run = this.probe(dir)
        .then(
          (probed) => void this.checks.set(dir, { at: new Date().toISOString(), probed }),
          (err: Error) => void this.checks.set(dir, { at: new Date().toISOString(), probed: this.checks.get(dir)?.probed ?? [], error: err.message }),
        )
        .finally(() => this.running.delete(dir));
      this.running.set(dir, run);
    }
    return run;
  }

  /**
   * Asks Claude Code which servers it loads in `dir` and how they are (its `mcp_status` control
   * request), with no turn sent, so no model is called. The repo's own `.mcp.json` servers are
   * turned off for it: Kelpie must not run a cloned repo's commands just to list them.
   */
  private probe(dir: string): Promise<Probed[]> {
    const project = new Set<string>();
    const root = repoRoot(dir);
    for (let d = dir; ; d = dirname(d)) {
      for (const [name] of entries(readJson(join(d, '.mcp.json'))?.mcpServers)) project.add(name);
      if (d === root || !root || dirname(d) === d) break;
    }
    const settings = JSON.stringify({ enableAllProjectMcpServers: false, disabledMcpjsonServers: [...project] });
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default', '--tools', 'Read', '--no-chrome', '--settings', settings];
    return new Promise((done, fail) => {
      const child = spawn(this.bin, args, { cwd: dir, env: { ...process.env, ...this.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      const started = Date.now();
      let n = 0;
      let settled = false;
      const finish = (err: Error | undefined, probed?: Probed[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(again);
        child.kill();
        if (err) fail(err);
        else done(probed ?? []);
      };
      let again: ReturnType<typeof setTimeout> | undefined;
      let last: Probed[] = [];
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
        last = servers.filter(isObj).map((s) => ({
          name: String(s.name),
          scope: String(s.scope ?? ''),
          status: statusOf(s.status),
          // Only a connector's entry is kept (its type, URL and id: the account signs it in); the rest come from the config files.
          config: s.scope === 'claudeai' && isObj(s.config) ? { type: s.config.type, url: s.config.url, id: s.config.id } : {},
        }));
        // Right after start it may not have loaded its config yet (an empty list), or be still connecting.
        const loading = !last.length && Date.now() - started < EMPTY_AFTER_MS;
        if (loading || last.some((s) => s.status === 'pending')) again = setTimeout(ask, n < 4 ? 250 : 500);
        else finish(undefined, last);
      });
      ask();
    });
  }
}
