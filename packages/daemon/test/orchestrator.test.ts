import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import { openStore, type Store } from '@kelpie/store';
import { createApp, Orchestrator, ORCHESTRATOR_TOOLS, READ_ONLY_TOOLS, SessionManager, type Session } from '../src/index.js';

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

const managers: SessionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stopAll()));
});

function setup(env: Record<string, string> = {}, opts: { maxAgents?: number; notifyDelayMs?: number; store?: Store; scratch?: boolean; cwd?: string } = {}) {
  const store = opts.store ?? openStore(':memory:');
  const argsFile = join(tmp('kelpie-args-'), 'args.jsonl');
  const orch = new Orchestrator({ store, mcpUrl: 'http://127.0.0.1:7317/mcp', maxAgents: opts.maxAgents ?? 4, notifyDelayMs: opts.notifyDelayMs ?? 300 });
  const sessions = new SessionManager({
    store,
    defaultCwd: opts.cwd ?? tmpdir(),
    runsDir: tmp('kelpie-runs-'),
    defaults: { bin: FAKE, env: { FAKE_FIXTURE: FIXTURE, FAKE_ARGS_FILE: argsFile, ...env } },
    hooks: orch,
    ...(opts.scratch ? { scratchDir: tmp('kelpie-scratch-') } : {}),
  });
  orch.attach(sessions);
  managers.push(sessions);
  const app = createApp(sessions, { orchestrator: orch });
  return { store, orch, sessions, app, argsFile };
}

/** Starts an orchestrator round-up and returns an MCP client holding its run's token. */
async function orchestrator(ctx: ReturnType<typeof setup>) {
  const parent = ctx.sessions.create();
  await parent.send('Do the things');
  const argv = await waitFor(() => jsonLines<string[]>(ctx.argsFile)[0]);
  const config = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!);
  const { url, headers } = config.mcpServers.kelpie;
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
  return { parent, argv, call, client, headers: headers as Record<string, string> };
}

/** A variadic flag's values: everything after it up to the next flag. */
function flag(args: string[], name: string): string[] {
  const i = args.indexOf(name);
  if (i < 0) return [];
  const end = args.findIndex((a, j) => j > i && a.startsWith('--'));
  return args.slice(i + 1, end < 0 ? undefined : end);
}

const sentTexts = (s: Session) => s.events().flatMap((e: KelpieEvent) => (e.kind === 'message' && e.data.sent ? [e.data.text] : []));

describe('orchestrator round-ups', () => {
  it('runs the orchestrator with read-only built-in tools and the kelpie MCP server, and no Bash', async () => {
    const ctx = setup();
    const { argv } = await orchestrator(ctx);
    expect(flag(argv, '--tools')).toEqual(['Read,Grep,Glob,AskUserQuestion']); // no Bash, Edit or Write without a scratch folder
    expect(ORCHESTRATOR_TOOLS).toEqual(['Read', 'Grep', 'Glob']);
    expect(flag(argv, '--allowedTools')).toEqual(['mcp__kelpie']);
    // Default mode, so any edit asks and `decide` answers it; never accept-edits.
    expect(flag(argv, '--permission-mode')).toEqual(['default']);
    expect(argv).not.toContain('--disallowedTools'); // nothing to write with, so nothing to deny
    const prompt = argv[argv.indexOf('--append-system-prompt') + 1]!;
    expect(prompt).toContain("You are Kelpie's orchestrator");
    expect(prompt).toContain('You may read the repo yourself with Read, Grep and Glob');
    expect(prompt).toContain('You cannot write files at all.');
  });

  it('gives the orchestrator write tools for its scratch folder only, and passes files from it to agents', async () => {
    const stdin = join(tmp('kelpie-stdin-'), 'stdin.jsonl');
    const repo = tmp('kelpie-cwd-');
    const ctx = setup({ FAKE_EVERY_TURN: '1', FAKE_STDIN_FILE: stdin }, { scratch: true, cwd: repo });
    const { parent, argv, call } = await orchestrator(ctx);
    const scratch = parent.scratch!;
    expect(flag(argv, '--tools')).toEqual(['Read,Grep,Glob,AskUserQuestion,Edit,Write']);
    expect(flag(argv, '--add-dir')).toEqual([scratch]);
    // No rule allows its edits, not even in the scratch folder: they ask, and `decide` answers.
    expect(flag(argv, '--allowedTools')).toEqual(['mcp__kelpie', `Read(/${scratch}/**)`]);
    expect(flag(argv, '--permission-mode')).toEqual(['default']);
    // Its repo may be read, but edits to it are denied outright, in case its settings allow them.
    const cwd = realpathSync(repo);
    expect(flag(argv, '--disallowedTools')).toEqual([`Edit(/${cwd}/**)`, `Write(/${cwd}/**)`]);
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toContain(`Write and Edit work only inside your scratch folder, \`${scratch}\``);

    writeFileSync(join(scratch, 'spec.md'), 'hello');
    expect((await call('spawn_agent', { title: 'A', task: 'x', writes: false, files: ['../escape.md'] })).error).toMatch(/no such file|outside your scratch folder/);
    expect((await call('spawn_agent', { title: 'A', task: 'x', writes: false, files: ['/etc/hosts'] })).error).toMatch(/outside your scratch folder/);
    expect((await call('spawn_agent', { title: 'A', task: 'x', writes: false, files: ['missing.md'] })).error).toMatch(/no such file/);
    expect(ctx.sessions.children(parent.id)).toHaveLength(0);

    const { data } = await call('spawn_agent', { title: 'Review', task: 'Review the spec', writes: false, files: ['spec.md'] });
    const child = ctx.sessions.get(data.agentId)!;
    const childArgv = await waitFor(() => jsonLines<string[]>(ctx.argsFile)[1]);
    // A reader may read the scratch folder, not write to it.
    expect(flag(childArgv, '--add-dir')).toEqual([scratch]);
    expect(flag(childArgv, '--allowedTools')).toEqual([`Read(/${scratch}/**)`]);
    expect(childArgv[childArgv.indexOf('--append-system-prompt') + 1]).toContain(`scratch folder, \`${scratch}\`, is shared`);
    const brief = await waitFor(() => jsonLines<{ text: string }>(stdin).find((l) => l.text.startsWith('Review the spec')));
    expect(brief.text).toBe(`Review the spec\n\n<attachments>\n- ${join(scratch, 'spec.md')} (file, 5 B)\n</attachments>`);
    const echo = await waitFor(() => child.events().find((e) => e.kind === 'message' && e.data.sent));
    expect(echo.kind === 'message' && echo.data.attachments?.map((a) => [a.name, a.size])).toEqual([['spec.md', 5]]);

    await waitFor(() => !child.working && child.lastTurn);
    await call('message_agent', { agentId: child.id, text: 'And this one', files: [join(scratch, 'spec.md')] });
    const followUp = await waitFor(() => jsonLines<{ text: string }>(stdin).find((l) => l.text.startsWith('And this one')));
    expect(followUp.text).toContain('<attachments>');
  });

  it("lets the orchestrator read its repo and scratch folder, write only in the scratch folder, and run nothing", async () => {
    const repo = tmp('kelpie-cwd-');
    const outside = tmp('kelpie-outside-');
    writeFileSync(join(repo, 'app.ts'), 'x');
    const ctx = setup({ FAKE_HANG: '1' }, { scratch: true, cwd: repo });
    const { parent } = await orchestrator(ctx);
    const scratch = parent.scratch!;
    const cwd = realpathSync(repo);
    const ask = (tool: string, input: Record<string, unknown>) => ctx.orch.decide(parent, { requestId: 'q', tool, title: tool, input });
    const allowed = (tool: string, input: Record<string, unknown>) => ask(tool, input)?.allow;

    expect(allowed('Read', { file_path: join(cwd, 'app.ts') })).toBe(true);
    expect(allowed('Read', { file_path: join(scratch, 'spec.md') })).toBe(true);
    expect(allowed('Grep', { pattern: 'x' })).toBe(true); // no path: its cwd
    expect(allowed('Grep', { pattern: 'x', path: scratch })).toBe(true);
    expect(allowed('Glob', { pattern: '**/*.ts', path: join(cwd, 'src') })).toBe(true);
    expect(allowed('Write', { file_path: join(scratch, 'spec.md'), content: 'x' })).toBe(true);
    expect(allowed('Edit', { file_path: join(scratch, 'spec.md') })).toBe(true);
    expect(allowed('Write', { file_path: join(scratch, 'notes', 'new.md'), content: 'x' })).toBe(true); // a file still to be made
    expect(allowed('mcp__kelpie__list_agents', {})).toBe(true);
    // A relative path is taken from its cwd, as the harness takes it, not from the scratch folder.
    expect(allowed('Read', { file_path: 'app.ts' })).toBe(true);
    expect(allowed('Glob', { pattern: '*.ts', path: 'src' })).toBe(true);
    expect(allowed('Write', { file_path: 'spec.md', content: 'x' })).toBe(false);

    expect(allowed('Write', { file_path: join(cwd, 'app.ts'), content: 'x' })).toBe(false);
    expect(allowed('Edit', { file_path: join(cwd, 'app.ts') })).toBe(false);
    expect(allowed('Read', { file_path: join(outside, 'secret') })).toBe(false);
    expect(allowed('Read', { file_path: join(cwd, '..', 'elsewhere') })).toBe(false);
    expect(allowed('Glob', { pattern: '*', path: '/' })).toBe(false);
    expect(allowed('Read', {})).toBe(false);
    expect(ask('Bash', { command: 'git status' })).toMatchObject({ allow: false, message: expect.stringMatching(/Give changes, commands/) });
    // A link in the repo can't lead its reads out of it.
    writeFileSync(join(outside, 'secret'), 'x');
    symlinkSync(outside, join(repo, 'link'));
    expect(allowed('Read', { file_path: join(cwd, 'link', 'secret') })).toBe(false);
    expect(allowed('Grep', { pattern: 'x', path: join(cwd, 'link', 'missing') })).toBe(false);
    symlinkSync(join(repo, 'app.ts'), join(scratch, 'into-repo'));
    expect(allowed('Write', { file_path: join(scratch, 'into-repo'), content: 'x' })).toBe(false);
    // A dangling link would have Write create its target, wherever that is.
    symlinkSync(join(repo, 'new.ts'), join(scratch, 'dangling'));
    expect(allowed('Write', { file_path: join(scratch, 'dangling'), content: 'x' })).toBe(false);
    symlinkSync(join(repo, 'missing-dir'), join(scratch, 'dangling-dir'));
    expect(allowed('Write', { file_path: join(scratch, 'dangling-dir', 'new.ts'), content: 'x' })).toBe(false);
    // `..` is refused rather than folded: the OS would follow the link first, then go up from its target.
    expect(allowed('Read', { file_path: `${cwd}/link/../app.ts` })).toBe(false);
    expect(allowed('Write', { file_path: `${scratch}/sub/../spec.md`, content: 'x' })).toBe(false);
    // A Glob pattern can't lead out of the directory it searches.
    expect(allowed('Glob', { pattern: '/etc/*', path: cwd })).toBe(false);
    expect(allowed('Glob', { pattern: '../**/*', path: cwd })).toBe(false);
    expect(allowed('Glob', { pattern: 'src/../../*' })).toBe(false);
    expect(allowed('Glob', { pattern: '~/.ssh/*' })).toBe(false);
    expect(allowed('Glob', { path: cwd })).toBe(false);
    // A sibling whose name starts with the same text is not inside.
    mkdirSync(`${cwd}c`);
    writeFileSync(`${cwd}c/f.ts`, 'x');
    expect(allowed('Read', { file_path: `${cwd}c/f.ts` })).toBe(false);
    expect(allowed('Grep', { pattern: 'x', path: `${cwd}c` })).toBe(false);
    expect(allowed('Write', { file_path: `${scratch}x/f.md`, content: 'x' })).toBe(false);
  });

  it('leaves out the repo deny rules when the scratch folder is inside the repo, rather than deny the scratch folder too', async () => {
    const ctx = setup({}, { scratch: true }); // scratch under the system temp dir, which is also the cwd
    const { parent, argv } = await orchestrator(ctx);
    expect(parent.scratch!.startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(argv).not.toContain('--disallowedTools');
    expect(flag(argv, '--allowedTools')).toContain(`Read(/${parent.scratch}/**)`);
  });

  it('rejects MCP calls without a live token', async () => {
    const ctx = setup();
    const req = (headers: Record<string, string>) =>
      ctx.app.request('/mcp', { method: 'POST', headers: { host: '127.0.0.1:7317', 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: '{}' });
    expect((await req({})).status).toBe(401);
    expect((await req({ authorization: 'Bearer nope' })).status).toBe(401);
    const { headers, parent } = await orchestrator(ctx);
    expect((await req({ ...headers, host: 'evil.example' })).status).toBe(403);
    await parent.stop(); // the token dies with the process
    expect((await req(headers)).status).toBe(401);
  });

  it('spawns sub-agents as child round-ups and reports back when they go idle', async () => {
    const ctx = setup({ FAKE_EVERY_TURN: '1' });
    const { parent, call } = await orchestrator(ctx);
    const a = await call('spawn_agent', { title: 'Count A', task: 'Count the TODOs in src/a', writes: false });
    const b = await call('spawn_agent', { title: 'Count B', task: 'Count the TODOs in src/b', writes: false });
    const ids = [a.data.agentId, b.data.agentId];
    expect(ctx.sessions.children(parent.id).map((c) => c.id)).toEqual(ids);
    expect(ctx.sessions.list().map((s) => s.id)).toEqual([parent.id]); // children stay out of the sidebar

    // Read-only agents get no edit tools and no kelpie MCP.
    const childArgv = await waitFor(() => jsonLines<string[]>(ctx.argsFile).length === 3 && jsonLines<string[]>(ctx.argsFile).slice(1));
    for (const argv of childArgv) {
      expect(argv[argv.indexOf('--tools') + 1]).toBe(READ_ONLY_TOOLS.join(','));
      expect(argv).not.toContain('--mcp-config');
    }

    // One notification covering both, once both are idle.
    const notes = await waitFor(() => {
      const n = sentTexts(parent).filter((t) => t.startsWith('<kelpie-notification>'));
      return n.length > 0 && n;
    });
    await sleep(500);
    const all = sentTexts(parent).filter((t) => t.startsWith('<kelpie-notification>'));
    expect(all).toHaveLength(1);
    expect(notes[0]).toContain(ids[0]);
    expect(notes[0]).toContain(ids[1]);
    expect(notes[0]).toContain('turn completed');

    const listed = await call('list_agents');
    expect(listed.data.agents.map((x: { status: string }) => x.status)).toEqual(['idle', 'idle']);
    expect(listed.data.agents[0].costUsd).toBe(0.0009); // the fixture's one turn, summed in SQL

    // Echoes carry who sent the turn: the brief came from the orchestrator, the notification from Kelpie.
    const sources = (s: Session) => s.events().flatMap((e) => (e.kind === 'message' && e.data.sent ? [e.data.source] : []));
    expect(sources(ctx.sessions.get(ids[0])!)).toEqual(['orchestrator']);
    expect(sources(parent)).toEqual(['user', 'kelpie']);
    // The notification's echo carries the agents for the UI; their reports only once, in the text.
    const note = parent.events().find((e) => e.kind === 'message' && e.data.source === 'kelpie');
    expect(note?.kind === 'message' && note.data.agents?.map((a) => [a.title, a.status, a.report])).toEqual([
      ['Count A', 'completed', undefined],
      ['Count B', 'completed', undefined],
    ]);
    expect(note?.kind === 'message' && note.data.text).toContain('is idle: turn completed\n\n4');
    const read = await call('read_agent', { agentId: ids[0] });
    expect(read.data).toMatchObject({ title: 'Count A', lastTurn: 'completed', report: '4' });
    const log = await call('read_agent', { agentId: ids[0], detail: 'log', limit: 2 });
    expect(log.data.lines).toHaveLength(2);
    expect(log.data.more).toBe(true);

    // The pane's view of each agent: kept current without reading logs, and pushed as it changes.
    const res = await ctx.app.request(`/api/sessions/${parent.id}/agents`, { headers: { host: '127.0.0.1:7317' } });
    const summaries = (await res.json()) as { title: string; status: string; now: string; model: string }[];
    expect(summaries.map((s) => [s.title, s.status, s.now])).toEqual([
      ['Count A', 'done', '4'],
      ['Count B', 'done', '4'],
    ]);
    expect(summaries[0]!.model).toBe('claude-haiku-5-5');
    const pushed: string[] = [];
    const unwatch = ctx.sessions.watch((u) => u.type === 'agent' && pushed.push(`${u.agent.title}:${u.agent.status}`));

    // A follow-up resumes the agent, and its next idle is reported in a new notification.
    await call('message_agent', { agentId: ids[0], text: 'Also count FIXMEs' });
    await waitFor(() => sentTexts(parent).filter((t) => t.startsWith('<kelpie-notification>')).length === 2);
    expect(sentTexts(ctx.sessions.get(ids[0])!)).toContain('Also count FIXMEs');
    await waitFor(() => pushed.at(-1) === 'Count A:done');
    unwatch();
  });

  it('refuses empty briefs and messages', async () => {
    const ctx = setup({ FAKE_HANG: '1' });
    const { call } = await orchestrator(ctx);
    expect((await call('spawn_agent', { title: 'A', task: '', writes: false })).error).toBeDefined();
    expect((await call('spawn_agent', { title: 'A', task: '   ', writes: false })).error).toMatch(/task is empty/);
    const { data } = await call('spawn_agent', { title: 'A', task: 'x', writes: false });
    expect((await call('message_agent', { agentId: data.agentId, text: '' })).error).toBeDefined();
  });

  it('follows the round-up mode: plan refuses writers, and agents run in the harness mode it maps to', async () => {
    const ctx = setup({ FAKE_HANG: '1' });
    const { parent, argv, call } = await orchestrator(ctx);
    // The orchestrator asks for what its rules don't settle, and `decide` answers; the mode is for its agents.
    expect(flag(argv, '--permission-mode')).toEqual(['default']);

    await ctx.sessions.setMode(parent, 'plan');
    expect((await call('spawn_agent', { title: 'W', task: 'edit', writes: true })).error).toMatch(/plan mode/);
    expect((await call('muster_agents', { agentIds: ['x'] })).error).toMatch(/plan mode/);
    expect((await call('list_agents')).data.mode).toBe('plan');
    const reader = await call('spawn_agent', { title: 'R', task: 'read', writes: false });
    expect(reader.error).toBeUndefined();
    const readerArgv = await waitFor(() => jsonLines<string[]>(ctx.argsFile)[1]);
    // Readers run in auto, with no blanket Bash allow: the harness's own checks decide.
    expect(flag(readerArgv, '--permission-mode')).toEqual(['auto']);
    expect(readerArgv).not.toContain('--allowedTools');
    expect(ctx.sessions.get(reader.data.agentId)!.info().mode).toBe('plan');

    await ctx.sessions.setMode(parent, 'acceptEdits');
    expect((await call('spawn_agent', { title: 'W', task: 'edit', writes: true })).error).toBeUndefined();
    const writerArgv = await waitFor(() => jsonLines<string[]>(ctx.argsFile)[2]);
    expect(flag(writerArgv, '--permission-mode')).toEqual(['acceptEdits']);
    await expect(ctx.sessions.setMode(ctx.sessions.get(reader.data.agentId)!, 'auto')).rejects.toThrow(/follows its round-up/);
  });

  it('restarts an idle orchestrator on a mode change, so its prompt says what the mode means', async () => {
    const ctx = setup({ FAKE_EVERY_TURN: '1' });
    const { parent, argv } = await orchestrator(ctx);
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).not.toContain('plan mode');
    await waitFor(() => parent.lastTurn && !parent.working);
    await ctx.sessions.setMode(parent, 'plan');
    await waitFor(() => parent.events().some((e) => e.kind === 'process.exited'));
    await parent.send('Plan the work');
    const next = await waitFor(() => jsonLines<string[]>(ctx.argsFile)[1]);
    expect(next[next.indexOf('--append-system-prompt') + 1]).toContain('The person has this round-up in plan mode');
    expect(flag(next, '--resume')).toHaveLength(1);
    // In plan mode it runs in the harness's own plan mode, with ExitPlanMode and still no edit allow rules.
    expect(flag(next, '--permission-mode')).toEqual(['plan']);
    expect(flag(next, '--tools')).toEqual(['Read,Grep,Glob,AskUserQuestion,ExitPlanMode']);
    expect(flag(next, '--allowedTools')).toEqual(['mcp__kelpie']);
    // Leaving plan mode takes its live harness to default mode, never accept-edits.
    const switched = vi.spyOn(parent, 'switchMode');
    await ctx.sessions.setMode(parent, 'acceptEdits');
    expect(switched).toHaveBeenCalledWith('default');
  });

  it('settles the orchestrator\'s scratch edits and kelpie tools itself in plan mode, and leaves its plan to the person', async () => {
    const ctx = setup({ FAKE_HANG: '1' }, { scratch: true });
    const parent = ctx.sessions.create(undefined, { mode: 'plan' });
    const ask = (tool: string, input: Record<string, unknown>) => ctx.orch.decide(parent, { requestId: 'q', tool, title: tool, input });
    expect(ask('Write', { file_path: join(parent.scratch!, 'plan.md'), content: 'x' })).toMatchObject({ allow: true });
    expect(ask('mcp__kelpie__spawn_agent', {})).toMatchObject({ allow: true });
    expect(ask('ExitPlanMode', { plan: 'x' })).toBeUndefined();
    await ctx.sessions.setMode(parent, 'auto');
    expect(ask('ExitPlanMode', { plan: 'x' })).toMatchObject({ allow: false });
  });

  it('caps working agents and allows one writer per repo', async () => {
    const ctx = setup({ FAKE_HANG: '1' }, { maxAgents: 3 });
    const { call } = await orchestrator(ctx);
    expect((await call('spawn_agent', { title: 'W1', task: 'edit', writes: true })).error).toBeUndefined();
    expect((await call('spawn_agent', { title: 'W2', task: 'edit', writes: true })).error).toMatch(/writing agent "W1" is still working/);
    expect((await call('spawn_agent', { title: 'R1', task: 'read', writes: false })).error).toBeUndefined();
    expect((await call('spawn_agent', { title: 'R2', task: 'read', writes: false })).error).toBeUndefined();
    expect((await call('spawn_agent', { title: 'R3', task: 'read', writes: false })).error).toMatch(/3 agents are already working/);
    // The writer and readers start at once, in either order: find the writer's by its prompt.
    const writerArgv = await waitFor(() => jsonLines<string[]>(ctx.argsFile).find((a) => a[a.indexOf('--append-system-prompt') + 1]?.includes('You may change files')));
    expect(writerArgv[writerArgv.indexOf('--tools') + 1]).toContain('Edit');
  });

  it("keeps one orchestrator out of another's agents", async () => {
    const ctx = setup({ FAKE_HANG: '1' });
    const first = await orchestrator(ctx);
    const { data } = await first.call('spawn_agent', { title: 'Mine', task: 'x', writes: false });
    const other = ctx.sessions.create();
    await other.send('hi');
    const argv = await waitFor(() =>
      jsonLines<string[]>(ctx.argsFile).find((a) => a.includes('--mcp-config') && JSON.stringify(a) !== JSON.stringify(first.argv)),
    );
    const token = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]!).mcpServers.kelpie.headers.Authorization.slice('Bearer '.length);
    const intruder = ctx.orch.authorize(token)!;
    expect(intruder.id).toBe(other.id);
    expect(() => ctx.orch.read(intruder, data.agentId)).toThrow(/no such agent/);
  });

  it("links the tickets in the person's messages to the round-up, and tells watchers", async () => {
    const ctx = setup({ FAKE_HANG: '1' });
    const seen: unknown[][] = [];
    const unwatch = ctx.sessions.watch((u) => u.type === 'session' && !u.session.parentId && seen.push(u.session.tickets));
    const parent = ctx.sessions.create();
    await parent.send('Ship guest checkout: https://acme.atlassian.net/browse/SHOP-412 and https://app.asana.com/0/1201/list. Also SHOP-999.');
    expect(parent.info().tickets).toMatchObject([
      { provider: 'jira', kind: 'issue', key: 'SHOP-412', url: 'https://acme.atlassian.net/browse/SHOP-412', source: 'auto' },
      { provider: 'asana', kind: 'project', url: 'https://app.asana.com/0/1201/list', source: 'auto' },
    ]);
    expect(seen.at(-1)).toHaveLength(2);
    // A link to one the round-up has changes nothing; one sent to an agent is the round-up's too.
    const agent = ctx.sessions.create(undefined, { parentId: parent.id, role: 'agent', title: 'A' });
    const before = seen.length;
    await parent.send('again https://acme.atlassian.net/jira/software/projects/SHOP/boards/3?selectedIssue=SHOP-412');
    expect(seen.slice(before).every((t) => t.length === 2)).toBe(true);
    await agent.send('see https://acme.atlassian.net/browse/SHOP-420');
    expect(parent.info().tickets.map((t) => t.key ?? t.kind)).toEqual(['SHOP-412', 'project', 'SHOP-420']);
    expect(agent.info().tickets).toEqual([]);
    unwatch();
  });

  it('lets the orchestrator link, title and unlink tickets', async () => {
    const ctx = setup({ FAKE_HANG: '1' });
    const { parent, call } = await orchestrator(ctx);
    const linked = await call('link_ticket', { url: 'https://app.asana.com/0/1201/list', title: 'Q4 checkout launch' });
    expect(linked.data.tickets).toMatchObject([{ provider: 'asana', kind: 'project', title: 'Q4 checkout launch', source: 'orchestrator' }]);
    await call('link_ticket', { url: 'https://acme.atlassian.net/browse/SHOP-412' });
    // Linking again, by another link to it, titles it.
    await call('link_ticket', { url: 'https://acme.atlassian.net/jira/software/c/projects/SHOP/issues/SHOP-412', title: 'Guest checkout API' });
    expect(parent.info().tickets.map((t) => [t.key, t.title])).toEqual([
      [undefined, 'Q4 checkout launch'],
      ['SHOP-412', 'Guest checkout API'],
    ]);
    expect((await call('link_ticket', { url: 'https://github.com/acme/web/issues/3' })).error).toMatch(/not a Jira issue or Asana/);
    expect((await call('link_ticket', { url: 'SHOP-412' })).error).toMatch(/not a Jira issue or Asana/);
    const { data } = await call('unlink_ticket', { url: 'https://app.asana.com/0/1201' });
    expect(data.tickets.map((t: { key?: string }) => t.key)).toEqual(['SHOP-412']);
    expect((await call('unlink_ticket', { url: 'https://app.asana.com/0/1201' })).error).toMatch(/no such ticket/);
    expect(ctx.store.ticketsOf(parent.id)).toHaveLength(1);
  });

  it('deletes sub-agents with their orchestrator', async () => {
    const ctx = setup({ FAKE_HANG: '1' });
    const { parent, call } = await orchestrator(ctx);
    const { data } = await call('spawn_agent', { title: 'A', task: 'x', writes: false });
    await ctx.sessions.delete(parent.id);
    expect(ctx.sessions.get(data.agentId)).toBeUndefined();
    expect(ctx.store.getSession(data.agentId)).toBeUndefined();
  });
});
