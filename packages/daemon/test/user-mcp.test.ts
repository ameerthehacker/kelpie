import { chmodSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStore } from '@kelpie/store';
import type { McpGrant } from '@kelpie/protocol';
import { notCommand, Orchestrator, SessionManager, type McpServers } from '../src/index.js';

const FAKE = join(import.meta.dirname, '../../adapters/test/fake-claude.mjs');
const FIXTURE = join(import.meta.dirname, '../../adapters/fixtures/claude-code/plain.jsonl');
chmodSync(FAKE, 0o755);

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

/** A variadic flag's values: everything after it up to the next flag. */
function flag(args: string[], name: string): string[] {
  const i = args.indexOf(name);
  if (i < 0) return [];
  const end = args.findIndex((a, j) => j > i && a.startsWith('--'));
  return args.slice(i + 1, end < 0 ? undefined : end);
}
const isOrchestrator = (argv: string[]) => argv.some((a) => a.includes("You are Kelpie's orchestrator"));

const managers: SessionManager[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(managers.splice(0).map((m) => m.stopAll()));
});

/** The person's servers as Kelpie found them: secrets and all, as they are only ever given to agents. */
const SERVERS: Record<string, object> = {
  github: { type: 'http', url: 'https://api.github.example/mcp', headers: { Authorization: 'Bearer sk-SECRET' } },
  'claude.ai Claude Docs': { type: 'claudeai-proxy', url: 'https://api.anthropic.com/v1/pages/mcp', id: 'mcpsrv_1' },
  notes: { command: 'notes-mcp' },
  'claude.ai My  Tiny - Echo': { type: 'claudeai-proxy', url: 'https://api.anthropic.com/v1/pages/mcp', id: 'mcpsrv_2' },
  kelpie: { command: 'evil' },
};

function setup(env: Record<string, string> = {}) {
  const store = openStore(':memory:');
  const argsFile = join(tmp('kelpie-args-'), 'args.jsonl');
  const answers = join(tmp('kelpie-answers-'), 'answers.jsonl');
  const asked: { cwd: string; allow: readonly McpGrant[] }[] = [];
  const warned: string[] = [];
  const mcpServers: Pick<McpServers, 'ensure' | 'forAgents' | 'warnOnce'> = {
    ensure: async (cwd, allow) => void asked.push({ cwd, allow }),
    forAgents: (_cwd, allow) => {
      const servers: Record<string, object> = {};
      const skipped: { name: string; reason: string }[] = [];
      for (const { name } of allow) if (name === 'kelpie') skipped.push({ name, reason: 'reserved' });
      else if (SERVERS[name]) servers[name] = SERVERS[name];
      return { servers, skipped };
    },
    warnOnce: (m) => void (warned.includes(m) || warned.push(m)),
  };
  const orch = new Orchestrator({ store, mcpUrl: 'http://127.0.0.1:7317/mcp', notifyDelayMs: 60_000, mcpServers });
  const sessions = new SessionManager({
    store,
    defaultCwd: tmpdir(),
    runsDir: tmp('kelpie-runs-'),
    defaults: { bin: FAKE, env: { FAKE_FIXTURE: FIXTURE, FAKE_ARGS_FILE: argsFile, FAKE_ANSWER_FILE: answers, ...env } },
    hooks: orch,
  });
  orch.attach(sessions);
  managers.push(sessions);
  return { store, orch, sessions, argsFile, answers, asked, warned };
}

/** An orchestrator round-up, and the argv of an agent it started. */
async function agentArgs(ctx: ReturnType<typeof setup>) {
  const parent = ctx.sessions.create();
  await parent.send('Go');
  await waitFor(() => jsonLines<string[]>(ctx.argsFile).length === 1);
  const { agentId } = await ctx.orch.spawn(parent, { title: 'Reader', task: 'look', writes: false });
  const argv = await waitFor(() => jsonLines<string[]>(ctx.argsFile).find((a) => !isOrchestrator(a)));
  const orchestrator = jsonLines<string[]>(ctx.argsFile).find(isOrchestrator)!;
  return { parent, agent: ctx.sessions.get(agentId)!, argv, orchestrator };
}

/** Grants as the Settings page sends them (the stub matches by name). */
const grants = (...names: string[]): McpGrant[] => names.map((name) => ({ scope: 'user', name, fingerprint: '0123456789abcdef' }));

const configs = (argv: string[]) => flag(argv, '--mcp-config').map((c) => Object.keys(JSON.parse(c).mcpServers));

describe("the person's MCP servers for agents", () => {
  it('gives agents none while the setting is off, however many are allowed', async () => {
    const ctx = setup();
    ctx.orch.settings.update({ mcpAllow: grants('github') });
    const { argv } = await agentArgs(ctx);
    expect(argv).toContain('--strict-mcp-config');
    expect(configs(argv)).toEqual([['kelpie']]);
    expect(argv).not.toContain('--settings');
    expect(ctx.asked).toEqual([]);
  });

  it('gives agents only the allowed servers, beside Kelpie’s, strict, with an ask rule for each and no allow rule', async () => {
    const ctx = setup();
    ctx.orch.settings.update({ useUserMcp: true, mcpAllow: grants('github', 'claude.ai Claude Docs') });
    const { argv, orchestrator } = await agentArgs(ctx);
    expect(argv).toContain('--strict-mcp-config');
    const [kelpie, own] = flag(argv, '--mcp-config').map((c) => JSON.parse(c).mcpServers);
    expect(Object.keys(kelpie)).toEqual(['kelpie']);
    expect(own).toEqual({ github: SERVERS.github, 'claude.ai Claude Docs': SERVERS['claude.ai Claude Docs'] });
    expect(JSON.parse(flag(argv, '--settings')[0]!)).toEqual({ permissions: { ask: ['mcp__github', 'mcp__claude_ai_Claude_Docs'] } });
    expect(flag(argv, '--allowedTools')).toEqual(['mcp__kelpie']);
    // The connector's entry was made sure of first, for the round-up's repo.
    expect(ctx.asked).toEqual([{ cwd: tmpdir(), allow: grants('github', 'claude.ai Claude Docs') }]);

    // The orchestrator never gets them.
    expect(orchestrator).toContain('--strict-mcp-config');
    expect(configs(orchestrator)).toEqual([['kelpie']]);
    expect(orchestrator).not.toContain('--settings');
  });

  it('writes the ask rule as Claude Code names the server: a claude.ai name with spaces and dashes', async () => {
    const ctx = setup();
    ctx.orch.settings.update({ useUserMcp: true, mcpAllow: grants('claude.ai My  Tiny - Echo') });
    const { argv } = await agentArgs(ctx);
    // The CLI collapses a claude.ai name's runs of _ (mcp-ask-dashes.jsonl: mcp__claude_ai_My_Tiny_-_Echo__echo).
    expect(JSON.parse(flag(argv, '--settings')[0]!).permissions.ask).toEqual(['mcp__claude_ai_My_Tiny_-_Echo']);
  });

  it('keeps a server named like Kelpie’s own out, and warns once', async () => {
    const ctx = setup();
    ctx.orch.settings.update({ useUserMcp: true, mcpAllow: grants('kelpie', 'notes') });
    const { argv, parent } = await agentArgs(ctx);
    expect(configs(argv)).toEqual([['kelpie'], ['notes']]);
    // Kelpie's own server is the one with the bearer token, not the person's `evil` command.
    expect(JSON.parse(flag(argv, '--mcp-config')[0]!).mcpServers.kelpie.type).toBe('http');
    expect(flag(argv, '--mcp-config').join()).not.toContain('evil');
    expect(JSON.parse(flag(argv, '--settings')[0]!).permissions.ask).toEqual(['mcp__notes']);
    await ctx.orch.spawn(parent, { title: 'Another', task: 'look', writes: false });
    await waitFor(() => jsonLines(ctx.argsFile).length === 3);
    expect(ctx.warned.filter((m) => m.includes('"kelpie"'))).toHaveLength(1);
  });

  it("routes every call to a person's MCP tool to the person, and remembers it per tool for the round-up", async () => {
    const ctx = setup({ FAKE_ASK: 'is:open', FAKE_ASK_TOOL: 'mcp__github__search_issues', FAKE_ASK_SERVER: 'github' });
    ctx.orch.settings.update({ useUserMcp: true, mcpAllow: grants('github') });
    const parent = ctx.sessions.create();
    await parent.send('Go');
    // The orchestrator's own ask (it never has the server) is refused by Kelpie's policy, never shown.
    await waitFor(() => jsonLines(ctx.answers).length === 1);
    expect(jsonLines<{ behavior: string }>(ctx.answers)[0]!.behavior).toBe('deny');
    const { agentId } = await ctx.orch.spawn(parent, { title: 'Reader', task: 'look', writes: false });
    const [pending] = await waitFor(() => ctx.sessions.approvals(parent.id).length === 1 && ctx.sessions.approvals(parent.id));
    expect(pending).toMatchObject({ sessionId: agentId, tool: 'mcp__github__search_issues', title: 'github › search_issues · query: "is:open"', rule: 'mcp__github__search_issues' });

    await ctx.sessions.answerApprovals({ items: [{ sessionId: agentId, requestId: pending!.requestId }], allow: true, remember: true });
    const answer = await waitFor(() => jsonLines<{ behavior: string; updatedPermissions?: unknown[] }>(ctx.answers)[1]);
    expect(answer).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'mcp__github__search_issues' }], behavior: 'allow', destination: 'session' }] });
    // The one tool, never the whole server.
    expect(ctx.sessions.rules(parent.id).map((r) => r.rule)).toEqual(['mcp__github__search_issues']);

    // A later agent asking for that tool is answered by the saved rule; its ask rule still sends the call to Kelpie.
    const later = await ctx.orch.spawn(parent, { title: 'Later', task: 'more', writes: false });
    await waitFor(() => ctx.sessions.get(later.agentId)!.events().some((e) => e.kind === 'permission.resolved'));
    const resolved = ctx.sessions.get(later.agentId)!.events().find((e) => e.kind === 'permission.resolved');
    expect(resolved?.kind === 'permission.resolved' && resolved.data.by).toBe('kelpie');
    const laterArgv = jsonLines<string[]>(ctx.argsFile).at(-1)!;
    expect(JSON.parse(flag(laterArgv, '--settings')[0]!).permissions.ask).toEqual(['mcp__github']);
    expect(ctx.sessions.approvals(parent.id)).toEqual([]);
  });

  it('asks again for another tool of a server one tool of which is remembered', async () => {
    const ctx = setup({ FAKE_ASK: 'x', FAKE_ASK_TOOL: 'mcp__github__create_issue', FAKE_ASK_SERVER: 'github' });
    ctx.orch.settings.update({ useUserMcp: true, mcpAllow: grants('github') });
    const parent = ctx.sessions.create();
    await parent.send('Go');
    await waitFor(() => jsonLines(ctx.answers).length === 1);
    ctx.store.addRule(parent.id, 'mcp__github__search_issues');
    await ctx.orch.spawn(parent, { title: 'Writer-ish', task: 'file it', writes: false });
    const [pending] = await waitFor(() => ctx.sessions.approvals(parent.id).length === 1 && ctx.sessions.approvals(parent.id));
    expect(pending).toMatchObject({ tool: 'mcp__github__create_issue', rule: 'mcp__github__create_issue' });
  });

  it('never sends an agent (or the orchestrator) a turn from Kelpie or the orchestrator that starts with /', async () => {
    const stdin = join(tmp('kelpie-stdin-'), 'stdin.jsonl');
    const ctx = setup({ FAKE_STDIN_FILE: stdin, FAKE_EVERY_TURN: '1' });
    const parent = ctx.sessions.create();
    // The person's own turns may be commands.
    await parent.send('/compact');
    await waitFor(() => jsonLines<{ text: string }>(stdin).some((l) => l.text === '/compact'));
    // A brief that would run the person's server's prompt (/mcp__gh__pr calls its prompts/get unasked).
    const { agentId } = await ctx.orch.spawn(parent, { title: 'Reader', task: '/mcp__gh__pr 12', writes: false });
    const brief = await waitFor(() => jsonLines<{ text: string }>(stdin).find((l) => l.text.includes('/mcp__gh__pr 12')));
    expect(brief.text.startsWith('From the orchestrator:\n/mcp__gh__pr 12')).toBe(true);
    const agent = ctx.sessions.get(agentId)!;
    await waitFor(() => !agent.working);
    await agent.send('  /clear', 'orchestrator');
    await agent.send('/resume', 'kelpie');
    await waitFor(() => jsonLines<{ text: string }>(stdin).some((l) => l.text.includes('/resume')));
    const texts = jsonLines<{ text: string }>(stdin).map((l) => l.text);
    expect(texts).toContain('From the orchestrator:\n  /clear');
    expect(texts.some((t) => t.startsWith('From Kelpie:\n/resume'))).toBe(true);
    expect(texts.filter((t) => /^\s*\//.test(t))).toEqual(['/compact']);
  });

  it('says who a turn is from only when it would read as a command', () => {
    expect(notCommand('/x', 'orchestrator')).toBe('From the orchestrator:\n/x');
    expect(notCommand('\n\t/x', 'kelpie')).toBe('From Kelpie:\n\n\t/x');
    expect(notCommand('do /x', 'orchestrator')).toBe('do /x');
    expect(notCommand('/x', 'user')).toBe('/x');
  });

  it("drops the rules saved for a server's tools when it is revoked, allowed anew, or the switch goes off", () => {
    const ctx = setup();
    const github: McpGrant = { scope: 'user', name: 'github', fingerprint: '0123456789abcdef' };
    const notes: McpGrant = { scope: 'user', name: 'notes', fingerprint: '0123456789abcdef' };
    const parent = ctx.sessions.create();
    const other = ctx.sessions.create();
    const rules = (id: string) => ctx.store.rulesOf(id).map((r) => r.rule).sort();
    // Rules saved before a server was allowed were for another server of that name.
    ctx.store.addRule(parent.id, 'mcp__github__search_issues');
    ctx.orch.settings.update({ useUserMcp: true, mcpAllow: [github, notes] });
    expect(rules(parent.id)).toEqual([]);

    const remember = () => {
      ctx.store.addRule(parent.id, 'mcp__github__search_issues');
      ctx.store.addRule(other.id, 'mcp__github__create_issue');
      ctx.store.addRule(parent.id, 'mcp__notes__read');
      ctx.store.addRule(parent.id, 'mcp__github_enterprise__x');
      ctx.store.addRule(parent.id, 'Bash(pnpm install)');
    };
    remember();
    // Revoked: its rules go, in every round-up; another server's, and other tools', stay.
    ctx.orch.settings.update({ mcpAllow: [notes] });
    expect(rules(parent.id)).toEqual(['Bash(pnpm install)', 'mcp__github_enterprise__x', 'mcp__notes__read']);
    expect(rules(other.id)).toEqual([]);

    // Allowed anew as it is now (its entry changed): the old rules were for what it was.
    ctx.orch.settings.update({ mcpAllow: [notes, github] });
    remember();
    ctx.orch.settings.update({ mcpAllow: [notes, { ...github, fingerprint: 'fedcba9876543210' }] });
    expect(rules(parent.id)).toEqual(['Bash(pnpm install)', 'mcp__github_enterprise__x', 'mcp__notes__read']);
    // A project server taking the name is a different grant too.
    remember();
    ctx.orch.settings.update({ mcpAllow: [notes, { scope: 'project', name: 'github', repo: '/r', fingerprint: 'fedcba9876543210' }] });
    expect(rules(other.id)).toEqual([]);
    // An unrelated change keeps them.
    remember();
    ctx.orch.settings.update({ maxAgents: 3 });
    expect(rules(other.id)).toEqual(['mcp__github__create_issue']);
    // Off: every allowed server's go.
    ctx.orch.settings.update({ useUserMcp: false });
    expect(rules(parent.id)).toEqual(['Bash(pnpm install)', 'mcp__github_enterprise__x']);
  });
});
