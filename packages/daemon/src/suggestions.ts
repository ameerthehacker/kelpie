import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import fuzzysort from 'fuzzysort';
import { LRUCache } from 'lru-cache';
import { parse as parseYaml } from 'yaml';
import type { FileMatches, SlashCommand } from '@kelpie/protocol';
import { runGit } from './worktrees.js';

type Obj = Record<string, any>;

/**
 * Built-in commands the CLI lists that a Kelpie session can't use, each with why. Everything else
 * the CLI lists runs when sent as a turn (Kelpie passes a person's slash command through as typed).
 */
export const EXCLUDED_COMMANDS: Record<string, string> = {
  // Kelpie keeps one CLI session per round-up and resumes it: a new one would lose the round-up's conversation.
  clear: 'starts a new CLI session, which Kelpie would lose track of',
  // Kelpie's composer sets these; changed inside the CLI they'd drift from what Kelpie shows, and go on a restart.
  model: "set with the composer's model menu",
  effort: "set with the composer's effort menu",
  fast: "the composer's model menu sets the model",
  // Names the CLI's own session, which Kelpie doesn't show; Kelpie titles round-ups itself.
  rename: 'Kelpie names round-ups itself',
  // The CLI marks these terminal-only (terminal_slash_commands); /focus answers "isn't available here".
  color: 'terminal only',
  focus: 'terminal only',
  doctor: 'terminal only',
  'reload-plugins': 'terminal only',
  heapdump: "dumps the CLI's own memory, for debugging Claude Code",
  agents: 'removed from Claude Code',
  'extra-usage': 'renamed to /usage-credits',
  'workflow-launch-exec': 'for server-launched sessions only',
};

const excluded = (c: Obj) => c.builtin === true && (Object.hasOwn(EXCLUDED_COMMANDS, c.name) || String(c.name).startsWith('__'));

/** Long skill descriptions are cut: the menu shows a line or two. */
const MAX_DESCRIPTION = 240;
const describe = (text: unknown) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_DESCRIPTION ? `${t.slice(0, MAX_DESCRIPTION - 1)}…` : t;
};

/** The commands Claude Code's `initialize` control response lists, as the menu shows them. */
export function cliCommands(listed: unknown): SlashCommand[] {
  if (!Array.isArray(listed)) return [];
  return listed
    .filter((c): c is Obj => !!c && typeof c === 'object' && typeof c.name === 'string' && !!c.name && !excluded(c))
    .map((c) => ({
      name: c.name,
      description: describe(c.description),
      argumentHint: typeof c.argumentHint === 'string' ? c.argumentHint : '',
      aliases: Array.isArray(c.aliases) ? c.aliases.filter((a: unknown): a is string => typeof a === 'string' && a !== c.name) : [],
      source: c.builtin ? 'built-in' : 'user',
    }));
}

/** A Markdown file's YAML frontmatter and the body after it; `{}` for none, or one that doesn't parse. */
export function frontmatter(text: string): { meta: Obj; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  try {
    const meta: unknown = parseYaml(m[1]!);
    return { meta: meta && typeof meta === 'object' ? (meta as Obj) : {}, body: text.slice(m[0].length) };
  } catch {
    return { meta: {}, body: text.slice(m[0].length) };
  }
}

const firstLine = (body: string) => body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
const str = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(' ') : '');

/** Enough for any repo's commands; a runaway tree is cut off. */
const MAX_DEPTH = 6;
const MAX_FILES = 500;

function markdownFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) break;
    const path = join(dir, e.name);
    if (e.isDirectory()) markdownFiles(path, depth + 1, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(path);
  }
  return out;
}

/** The directories whose `.claude` the CLI reads for a session in `cwd`: up to the repo's root, the person's home aside (theirs is user-level). */
function projectDirs(cwd: string, home: string): string[] {
  const dirs: string[] = [];
  for (let d = cwd; ; d = dirname(d)) {
    if (d !== home) dirs.push(d);
    if (existsSync(join(d, '.git')) || dirname(d) === d) return dirs;
  }
}

/**
 * The repo's own commands and skills, as Claude Code names them: `.claude/commands/a/b.md` is
 * `/a:b`, described by its frontmatter or else its first line; `.claude/skills/<name>/SKILL.md`
 * is `/<name>` unless it says `user-invocable: false`. Read from the files: the CLI is never
 * started in the repo for this, where its hooks would run. The nearest directory's win.
 */
export function projectCommands(cwd: string, home = homedir()): SlashCommand[] {
  const found = new Map<string, SlashCommand>();
  const add = (name: string, meta: Obj, body: string) => {
    if (!name || found.has(name)) return;
    found.set(name, { name, description: describe(str(meta.description) || firstLine(body)), argumentHint: str(meta['argument-hint']), aliases: [], source: 'project' });
  };
  const read = (path: string) => {
    try {
      return frontmatter(readFileSync(path, 'utf8'));
    } catch {
      return undefined;
    }
  };
  for (const dir of projectDirs(cwd, home)) {
    const commands = join(dir, '.claude', 'commands');
    for (const path of markdownFiles(commands)) {
      const md = read(path);
      if (md) add(relative(commands, path).slice(0, -'.md'.length).split(sep).join(':'), md.meta, md.body);
    }
    const skills = join(dir, '.claude', 'skills');
    let names: string[] = [];
    try {
      names = readdirSync(skills);
    } catch {}
    for (const name of names) {
      const md = read(join(skills, name, 'SKILL.md'));
      if (md && md.meta['user-invocable'] !== false) add(typeof md.meta.name === 'string' ? md.meta.name : name, md.meta, md.body);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface SuggestionsOptions {
  /** The CLI: a command on PATH or a path. Default `claude`. */
  bin?: string;
  /** More environment for it. */
  env?: Record<string, string>;
  /** Where the CLI is started to list its commands: an empty directory, never a repo. Default the temp dir. */
  neutralDir?: string;
  /** How long the CLI may take to answer. Default 15 seconds. */
  timeoutMs?: number;
  /** How long its list is kept. Default 5 minutes (a failure, 30 seconds). */
  commandsTtlMs?: number;
  /** How long a repo's file list is kept. Default 30 seconds. */
  filesTtlMs?: number;
  /** The person's home, whose `.claude` is theirs, not a repo's. */
  home?: string;
}

/** The most files a repo's list holds; past that, matches come from the first ones git lists. */
const MAX_REPO_FILES = 200_000;
export const MAX_FILE_MATCHES = 50;

interface FileList {
  at: number;
  files: Fuzzysort.Prepared[];
  total: number;
}

/**
 * The composer's suggestions: the slash commands a session can be sent, and the repo's files to
 * mention. The CLI is asked for its commands with its `initialize` control request (the list the
 * Agent SDK's `supportedCommands()` gives), no turn sent, so no model is called; with only the
 * person's own settings, so a repo's hooks never run for it. The repo's commands are read from disk.
 */
export class Suggestions {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly commandsTtlMs: number;
  private readonly filesTtlMs: number;
  private cli: { at: number; ttl: number; commands: Promise<SlashCommand[]> } | undefined;
  private readonly lists = new LRUCache<string, Promise<FileList>>({ max: 8 });
  private warned = false;

  constructor(private readonly opts: SuggestionsOptions = {}) {
    this.bin = opts.bin ?? 'claude';
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.commandsTtlMs = opts.commandsTtlMs ?? 5 * 60_000;
    this.filesTtlMs = opts.filesTtlMs ?? 30_000;
  }

  /** What `/` offers a session in `cwd`: the repo's own commands first, then the CLI's. */
  async commands(cwd: string): Promise<SlashCommand[]> {
    const project = projectCommands(cwd, this.opts.home);
    const names = new Set(project.map((c) => c.name));
    return [...project, ...(await this.cliCommands()).filter((c) => !names.has(c.name))];
  }

  private cliCommands(): Promise<SlashCommand[]> {
    if (this.cli && Date.now() - this.cli.at < this.cli.ttl) return this.cli.commands;
    const cli = { at: Date.now(), ttl: this.commandsTtlMs, commands: Promise.resolve<SlashCommand[]>([]) };
    cli.commands = this.probe().then(cliCommands, (err: Error) => {
      // Not installed, or not answering: the repo's commands are still offered, and it is asked again soon.
      cli.ttl = Math.min(this.commandsTtlMs, 30_000);
      if (!this.warned) console.error(`kelpie: could not list Claude Code's slash commands: ${err.message}`);
      this.warned = true;
      return [];
    });
    this.cli = cli;
    return cli.commands;
  }

  private probe(): Promise<unknown> {
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', 'Read', '--no-chrome', '--strict-mcp-config',
      '--no-session-persistence', '--setting-sources', 'user',
    ];
    return new Promise((done, fail) => {
      const cwd = this.opts.neutralDir ?? tmpdir();
      const child = spawn(this.bin, args, { cwd, env: { ...process.env, ...this.opts.env, PWD: cwd }, stdio: ['pipe', 'pipe', 'pipe'] });
      let settled = false;
      const finish = (err: Error | undefined, commands?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        if (err) fail(err);
        else done(commands);
      };
      const timer = setTimeout(() => finish(new Error('Claude Code did not answer in time')), this.timeoutMs);
      child.on('error', (err) => finish(new Error(`could not run ${this.bin}: ${err.message}`)));
      child.on('close', (code) => finish(new Error(`Claude Code exited (${code}) before listing its commands`)));
      child.stdin.on('error', () => {});
      createInterface({ input: child.stdout }).on('line', (line) => {
        let o: Obj;
        try {
          o = JSON.parse(line) as Obj;
        } catch {
          return;
        }
        if (o.type !== 'control_response') return;
        const commands: unknown = o.response?.response?.commands;
        if (!Array.isArray(commands)) return finish(new Error(o.response?.error ? String(o.response.error) : 'Claude Code gave no command list'));
        finish(undefined, commands);
      });
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'kelpie-commands', request: { subtype: 'initialize' } }) + '\n');
    });
  }

  /** The repo files under `cwd` best matching `query` (fuzzy), at most `limit`; with no query, the first ones. */
  async files(cwd: string, query: string, limit = MAX_FILE_MATCHES): Promise<FileMatches> {
    const list = await this.fileList(cwd);
    const n = Math.max(1, Math.min(limit, MAX_FILE_MATCHES));
    const q = query.trim();
    const files = q ? fuzzysort.go(q, list.files, { limit: n }).map((r) => r.target) : list.files.slice(0, n).map((f) => f.target);
    return { files, total: list.total };
  }

  private fileList(cwd: string): Promise<FileList> {
    const cached = this.lists.get(cwd);
    if (cached) return cached.then((l) => (Date.now() - l.at < this.filesTtlMs ? l : this.listFiles(cwd)));
    return this.listFiles(cwd);
  }

  private listFiles(cwd: string): Promise<FileList> {
    const at = Date.now();
    const git = (args: string[]) => runGit(cwd, ['ls-files', '-z', ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 15_000 });
    // Tracked files and new ones not ignored, relative to `cwd`, less those deleted; NUL-separated, so any name reads right.
    const list = Promise.all([git(['--cached', '--others', '--exclude-standard', '--deduplicate']), git(['--deleted'])]).then(([listed, deleted]) => {
      if (listed.code !== 0 && !listed.overflow) return { at, files: [], total: 0 };
      const gone = new Set(deleted.code === 0 ? deleted.stdout.split('\0') : []);
      const all = listed.stdout.split('\0').filter((f) => f && !gone.has(f));
      return { at, files: all.slice(0, MAX_REPO_FILES).map((f) => fuzzysort.prepare(f)), total: all.length };
    });
    this.lists.set(cwd, list);
    // A failure isn't kept.
    list.catch(() => this.lists.delete(cwd));
    return list;
  }
}
