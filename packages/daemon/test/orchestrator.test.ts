import { chmodSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
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

function setup(env: Record<string, string> = {}, opts: { maxAgents?: number; notifyDelayMs?: number; store?: Store } = {}) {
  const store = opts.store ?? openStore(':memory:');
  const argsFile = join(tmp('kelpie-args-'), 'args.jsonl');
  const orch = new Orchestrator({ store, mcpUrl: 'http://127.0.0.1:7317/mcp', maxAgents: opts.maxAgents ?? 4, notifyDelayMs: opts.notifyDelayMs ?? 300 });
  const sessions = new SessionManager({
    store,
    defaultCwd: tmpdir(),
    runsDir: tmp('kelpie-runs-'),
    defaults: { bin: FAKE, env: { FAKE_FIXTURE: FIXTURE, FAKE_ARGS_FILE: argsFile, ...env } },
    hooks: orch,
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

const sentTexts = (s: Session) => s.events().flatMap((e: KelpieEvent) => (e.kind === 'message' && e.data.sent ? [e.data.text] : []));

describe('orchestrator round-ups', () => {
  it('runs the orchestrator with no built-in tools, only the kelpie MCP server', async () => {
    const ctx = setup();
    const { argv } = await orchestrator(ctx);
    expect(argv[argv.indexOf('--tools') + 1]).toBe(''); // no built-in tools at all
    expect(ORCHESTRATOR_TOOLS).toEqual([]);
    expect(argv.slice(argv.indexOf('--allowedTools'), argv.indexOf('--allowedTools') + 2)).toEqual(['--allowedTools', 'mcp__kelpie']);
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toContain("You are Kelpie's orchestrator");
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

  it('caps working agents and allows one writer per repo', async () => {
    const ctx = setup({ FAKE_HANG: '1' }, { maxAgents: 3 });
    const { call } = await orchestrator(ctx);
    expect((await call('spawn_agent', { title: 'W1', task: 'edit', writes: true })).error).toBeUndefined();
    expect((await call('spawn_agent', { title: 'W2', task: 'edit', writes: true })).error).toMatch(/writing agent "W1" is still working/);
    expect((await call('spawn_agent', { title: 'R1', task: 'read', writes: false })).error).toBeUndefined();
    expect((await call('spawn_agent', { title: 'R2', task: 'read', writes: false })).error).toBeUndefined();
    expect((await call('spawn_agent', { title: 'R3', task: 'read', writes: false })).error).toMatch(/3 agents are already working/);
    const writerArgv = await waitFor(() => jsonLines<string[]>(ctx.argsFile)[1]);
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

  it('deletes sub-agents with their orchestrator', async () => {
    const ctx = setup({ FAKE_HANG: '1' });
    const { parent, call } = await orchestrator(ctx);
    const { data } = await call('spawn_agent', { title: 'A', task: 'x', writes: false });
    await ctx.sessions.delete(parent.id);
    expect(ctx.sessions.get(data.agentId)).toBeUndefined();
    expect(ctx.store.getSession(data.agentId)).toBeUndefined();
  });
});
