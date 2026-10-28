import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '@kelpie/store';
import { cliCommands, createApp, frontmatter, projectCommands, SessionManager, Suggestions } from '../src/index.js';
import { git, jsonLines } from './review-fixtures.js';

const FAKE = join(import.meta.dirname, 'fake-claude-commands.mjs');
chmodSync(FAKE, 0o755);
const host = { host: '127.0.0.1:7317' };

const LISTED = [
  { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>', builtin: true },
  { name: 'clear', description: 'Start a new session with empty context', argumentHint: '[name]', aliases: ['reset', 'new'], builtin: true },
  { name: 'model', description: 'Set the AI model for Claude Code', argumentHint: '<model>', builtin: true },
  { name: '__remote-workflow', description: 'Server-launched sessions only', argumentHint: '', builtin: true },
  { name: 'code-review', description: 'Review the current diff', argumentHint: '[low|high]', aliases: ['review'], builtin: true },
  { name: 'claude-hud:setup', description: '(claude-hud) Configure claude-hud as your statusline', argumentHint: '' },
];

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A git repo with a project command, a nested one, a skill and a hidden skill. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kelpie-suggest-'));
  git(dir, 'init', '-q');
  write(join(dir, '.claude/commands/hello.md'), '---\ndescription: Say hello\nargument-hint: "[name]"\n---\nSay hello to $ARGUMENTS\n');
  write(join(dir, '.claude/commands/front/comp.md'), '# Make a component\n\nBody.\n');
  write(join(dir, '.claude/skills/deploy/SKILL.md'), '---\nname: ship-it\ndescription: >\n  Ship the app\n  to staging\n---\nSteps\n');
  write(join(dir, '.claude/skills/internal/SKILL.md'), '---\ndescription: Only for the model\nuser-invocable: false\n---\n');
  return dir;
}

describe('slash commands', () => {
  it("keeps the CLI's commands a Kelpie session can run, with their aliases", () => {
    const commands = cliCommands(LISTED);
    expect(commands.map((c) => c.name)).toEqual(['compact', 'code-review', 'claude-hud:setup']);
    expect(commands[1]).toEqual({ name: 'code-review', description: 'Review the current diff', argumentHint: '[low|high]', aliases: ['review'], source: 'built-in' });
    expect(commands[2]!.source).toBe('user');
    expect(cliCommands(undefined)).toEqual([]);
  });

  it('cuts long descriptions to a line or two', () => {
    const [c] = cliCommands([{ name: 'dataviz', description: 'word '.repeat(200), builtin: true }]);
    expect(c!.description.length).toBeLessThanOrEqual(240);
    expect(c!.description.endsWith('…')).toBe(true);
  });

  it('reads frontmatter, and tolerates none or a broken one', () => {
    expect(frontmatter('---\ndescription: Hi\n---\nbody').meta).toEqual({ description: 'Hi' });
    expect(frontmatter('just text')).toEqual({ meta: {}, body: 'just text' });
    expect(frontmatter('---\n: [oops\n---\nbody')).toEqual({ meta: {}, body: 'body' });
  });

  it("names the repo's commands and skills as Claude Code does, from a subdirectory too", () => {
    const dir = repo();
    const sub = join(dir, 'packages/app');
    mkdirSync(sub, { recursive: true });
    write(join(sub, '.claude/commands/hello.md'), '---\ndescription: The nearer hello\n---\n');
    const byName = Object.fromEntries(projectCommands(sub, '/nonexistent-home').map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(['front:comp', 'hello', 'ship-it']);
    expect(byName.hello).toMatchObject({ description: 'The nearer hello', source: 'project' });
    expect(byName['front:comp']!.description).toBe('Make a component');
    expect(byName['ship-it']!.description).toBe('Ship the app to staging');
    expect(projectCommands(dir, '/nonexistent-home').find((c) => c.name === 'hello')).toEqual({
      name: 'hello',
      description: 'Say hello',
      argumentHint: '[name]',
      aliases: [],
      source: 'project',
    });
  });

  it("asks the CLI once, outside the repo and with only the person's settings, and puts the repo's first", async () => {
    const dir = repo();
    const neutral = mkdtempSync(join(tmpdir(), 'kelpie-neutral-'));
    const argsFile = join(neutral, 'args.jsonl');
    const s = new Suggestions({ bin: FAKE, neutralDir: neutral, home: '/nonexistent-home', env: { FAKE_COMMANDS: JSON.stringify(LISTED), FAKE_COMMANDS_ARGS_FILE: argsFile } });
    const names = (await s.commands(dir)).map((c) => c.name);
    expect(names).toEqual(['front:comp', 'hello', 'ship-it', 'compact', 'code-review', 'claude-hud:setup']);
    await s.commands(dir);
    const starts = jsonLines<{ args: string[]; cwd: string }>(argsFile);
    expect(starts).toHaveLength(1);
    expect(starts[0]!.args).toEqual(expect.arrayContaining(['--setting-sources', 'user', '--no-session-persistence', '--strict-mcp-config']));
    expect(starts[0]!.cwd).not.toContain('kelpie-suggest-');
  });

  it("still offers the repo's commands when the CLI can't answer", async () => {
    const s = new Suggestions({ bin: FAKE, timeoutMs: 300, home: '/nonexistent-home', env: { FAKE_COMMANDS_SILENT: '1' } });
    expect((await s.commands(repo())).map((c) => c.name)).toEqual(['front:comp', 'hello', 'ship-it']);
    const missing = new Suggestions({ bin: join(tmpdir(), 'no-such-claude'), home: '/nonexistent-home' });
    expect(await missing.commands(mkdtempSync(join(tmpdir(), 'kelpie-empty-')))).toEqual([]);
  });
});

describe('file mentions', () => {
  function files() {
    const dir = mkdtempSync(join(tmpdir(), 'kelpie-files-'));
    git(dir, 'init', '-q');
    for (const f of ['src/components/chat/composer.tsx', 'src/lib/utils.ts', 'README.md', 'gone.txt']) write(join(dir, f), 'x\n');
    write(join(dir, '.gitignore'), 'dist/\n');
    write(join(dir, 'dist/bundle.js'), 'x\n');
    git(dir, 'add', '-A');
    write(join(dir, 'src/new-file.ts'), 'x\n');
    rmSync(join(dir, 'gone.txt'));
    return dir;
  }

  it('fuzzy-matches tracked and new files, never ignored or deleted ones', async () => {
    const dir = files();
    const s = new Suggestions();
    const all = await s.files(dir, '');
    expect(all.files.sort()).toEqual(['.gitignore', 'README.md', 'src/components/chat/composer.tsx', 'src/lib/utils.ts', 'src/new-file.ts']);
    expect(all.total).toBe(5);
    expect((await s.files(dir, 'compsr')).files).toEqual(['src/components/chat/composer.tsx']);
    expect((await s.files(dir, 'bundle')).files).toEqual([]);
    expect((await s.files(dir, '', 2)).files).toHaveLength(2);
  });

  it('keeps the list for a while, then lists again', async () => {
    const dir = files();
    const s = new Suggestions({ filesTtlMs: 60_000 });
    await s.files(dir, '');
    write(join(dir, 'later.ts'), 'x\n');
    expect((await s.files(dir, 'later')).files).toEqual([]);
    const fresh = new Suggestions({ filesTtlMs: 0 });
    await fresh.files(dir, '');
    write(join(dir, 'later2.ts'), 'x\n');
    expect((await fresh.files(dir, 'later2')).files).toEqual(['later2.ts']);
  });

  it('offers nothing outside a git repo', async () => {
    expect(await new Suggestions().files(mkdtempSync(join(tmpdir(), 'kelpie-nogit-')), '')).toEqual({ files: [], total: 0 });
  });
});

describe('suggestions API', () => {
  const setup = (defaultCwd: string) => {
    const sessions = new SessionManager({ store: openStore(':memory:'), defaultCwd, runsDir: mkdtempSync(join(tmpdir(), 'kelpie-runs-')) });
    const suggestions = new Suggestions({ bin: FAKE, home: '/nonexistent-home', env: { FAKE_COMMANDS: JSON.stringify(LISTED) } });
    return { sessions, app: createApp(sessions, { suggestions }) };
  };

  it("serves Kelpie's repo before a round-up exists, and a session's own directory", async () => {
    const dir = repo();
    write(join(dir, 'src/app.ts'), 'x\n');
    const { app, sessions } = setup(dir);
    const commands = await (await app.request('/api/suggestions/commands', { headers: host })).json();
    expect(commands.commands.map((c: { name: string }) => c.name)).toContain('hello');
    const files = await (await app.request('/api/suggestions/files?q=app', { headers: host })).json();
    expect(files.files).toEqual(['src/app.ts']);

    const other = mkdtempSync(join(tmpdir(), 'kelpie-other-'));
    git(other, 'init', '-q');
    write(join(other, 'elsewhere.ts'), 'x\n');
    const s = sessions.create(other);
    const there = await (await app.request(`/api/suggestions/files?session=${s.id}`, { headers: host })).json();
    expect(there.files).toEqual(['elsewhere.ts']);
    const theirs = await (await app.request(`/api/suggestions/commands?session=${s.id}`, { headers: host })).json();
    expect(theirs.commands.map((c: { name: string }) => c.name)).not.toContain('hello');
  });

  it('refuses an unknown session and a bad limit', async () => {
    const { app } = setup(tmpdir());
    expect((await app.request('/api/suggestions/commands?session=nope', { headers: host })).status).toBe(404);
    expect((await app.request('/api/suggestions/files?session=nope', { headers: host })).status).toBe(404);
    expect((await app.request('/api/suggestions/files?limit=0', { headers: host })).status).toBe(400);
  });
});
