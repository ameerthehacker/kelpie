import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_AGENTS } from '@kelpie/protocol';
import { openStore, type Store } from '@kelpie/store';
import { createApp, Orchestrator, SavedSettings, SessionManager } from '../src/index.js';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOCAL = { host: '127.0.0.1:7317' };
const FP = '0123456789abcdef';

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
  vi.restoreAllMocks();
  await Promise.all(managers.splice(0).map((m) => m.stopAll()));
});

function start(store: Store = openStore(':memory:'), maxAgents?: number) {
  const orch = new Orchestrator({ store, mcpUrl: 'http://127.0.0.1:7317/mcp', ...(maxAgents ? { maxAgents } : {}) });
  const sessions = new SessionManager({ store, defaultCwd: tmpdir(), runsDir: tmp('kelpie-runs-'), hooks: orch });
  orch.attach(sessions);
  managers.push(sessions);
  return { store, orch, sessions, app: createApp(sessions, { orchestrator: orch }) };
}

const put = (app: ReturnType<typeof start>['app'], body: string) =>
  app.request('/api/settings', { method: 'PUT', headers: { ...LOCAL, 'content-type': 'application/json' }, body });

describe('settings', () => {
  it('saves the agent limit, and keeps it across a restart', () => {
    const db = join(tmp('kelpie-home-'), 'kelpie.db');
    let store = openStore(db);
    expect(store.settings()).toEqual({});
    const first = new SavedSettings(store);
    expect(first.get()).toEqual({ maxAgents: 4, autoResume: true, useUserMcp: false, mcpAllow: [], delegation: 'balanced' });
    expect(first.update({ maxAgents: 9 })).toEqual({ maxAgents: 9, autoResume: true, useUserMcp: false, mcpAllow: [], delegation: 'balanced' });
    store.close();
    store = openStore(db);
    expect(store.settings()).toEqual({ maxAgents: 9 });
    expect(new SavedSettings(store).get()).toEqual({ maxAgents: 9, autoResume: true, useUserMcp: false, mcpAllow: [], delegation: 'balanced' });
    // A saved setting wins over the one Kelpie was started with (KELPIE_MAX_AGENTS).
    expect(new SavedSettings(store, { maxAgents: 2 }).get()).toEqual({ maxAgents: 9, autoResume: true, useUserMcp: false, mcpAllow: [], delegation: 'balanced' });
    store.close();
  });

  it('defaults to the limit Kelpie was started with, clamped into range, until one is saved', () => {
    const store = openStore(':memory:');
    expect(new SavedSettings(store, { maxAgents: 6 }).get().maxAgents).toBe(6);
    expect(new SavedSettings(store, { maxAgents: 100 }).get().maxAgents).toBe(MAX_AGENTS.max);
    expect(new SavedSettings(store, { maxAgents: 2.7 }).get().maxAgents).toBe(2);
    // A value saved outside today's range (an older version's) falls back to the default.
    store.setSettings({ maxAgents: 99 });
    expect(new SavedSettings(store, { maxAgents: 5 }).get().maxAgents).toBe(5);
  });

  it('refuses a limit out of range, or anything else, and changes nothing', () => {
    const settings = new SavedSettings(openStore(':memory:'));
    const changed = vi.fn();
    settings.onChange(changed);
    expect(() => settings.update({ maxAgents: 0 })).toThrow('maxAgents must be at least 1');
    expect(() => settings.update({ maxAgents: 17 })).toThrow('maxAgents can be at most 16');
    expect(() => settings.update({ maxAgents: 2.5 })).toThrow('maxAgents must be a whole number');
    expect(() => settings.update({ maxAgents: '4' })).toThrow('maxAgents must be a whole number');
    expect(() => settings.update({ theme: 'dark' })).toThrow('unknown setting: theme');
    expect(() => settings.update({})).toThrow('nothing to change');
    expect(() => settings.update(null)).toThrow();
    expect(() => settings.update({ maxAgents: undefined, extra: null })).toThrow('unknown setting: extra');
    expect(settings.get()).toEqual({ maxAgents: 4, autoResume: true, useUserMcp: false, mcpAllow: [], delegation: 'balanced' });
    expect(changed).not.toHaveBeenCalled();
    settings.update({ maxAgents: 16 });
    expect(changed).toHaveBeenCalledWith({ maxAgents: 16, autoResume: true, useUserMcp: false, mcpAllow: [], delegation: 'balanced' }, { maxAgents: 4, autoResume: true, useUserMcp: false, mcpAllow: [], delegation: 'balanced' });
  });

  it('forgets a saved limit on null, so the default (KELPIE_MAX_AGENTS) applies again', () => {
    const store = openStore(':memory:');
    const settings = new SavedSettings(store, { maxAgents: 6 });
    settings.update({ maxAgents: 2 });
    expect(store.settings()).toEqual({ maxAgents: 2 });
    expect(settings.update({ maxAgents: null })).toEqual({ maxAgents: 6, autoResume: true, useUserMcp: false, mcpAllow: [], delegation: 'balanced' });
    expect(store.settings()).toEqual({});
    expect(new SavedSettings(store, { maxAgents: 9 }).get().maxAgents).toBe(9);
  });

  it('serves the settings with their range, and validates changes', async () => {
    const ctx = start(undefined, 3);
    const got = await ctx.app.request('/api/settings', { headers: LOCAL });
    // The default a reset puts back is the one Kelpie was started with.
    expect(await got.json()).toEqual({ maxAgents: 3, autoResume: true, useUserMcp: false, mcpAllow: [], delegation: 'balanced', limits: { maxAgents: { min: 1, max: 16, default: 3 } } });

    const ok = await put(ctx.app, JSON.stringify({ maxAgents: 8 }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ maxAgents: 8 });
    expect(ctx.orch.maxAgents).toBe(8);
    expect(ctx.store.settings()).toEqual({ maxAgents: 8 });

    for (const [body, error] of [
      [{ maxAgents: 0 }, 'maxAgents must be at least 1'],
      [{ maxAgents: 33 }, 'maxAgents can be at most 16'],
      [{ maxAgents: 1.5 }, 'maxAgents must be a whole number'],
      [{ maxAgents: '5' }, 'maxAgents must be a whole number'],
      [{ other: 1 }, 'unknown setting: other'],
      [{}, 'nothing to change: send maxAgents, autoResume, useUserMcp, mcpAllow or delegation'],
      [{ autoResume: 'yes' }, 'autoResume must be true or false'],
      [{ useUserMcp: 'on' }, 'useUserMcp must be true or false'],
      [{ mcpAllow: 'github' }, 'mcpAllow must be a list of servers, as the server list gives them'],
      // A name alone is not enough: which server it is, and what it runs.
      [{ mcpAllow: ['github'] }, 'Invalid input: expected object, received string'],
      [{ mcpAllow: [{ scope: 'user', name: 'github' }] }, 'fingerprint must be text'],
      [{ mcpAllow: [{ scope: 'user', name: 'github', fingerprint: 'nothex' }] }, 'fingerprint must be 16 hex digits, as the server list gives it'],
      [{ mcpAllow: [{ scope: 'team', name: 'github', fingerprint: FP }] }, 'scope must be user, project, local or claudeai'],
      [{ mcpAllow: [{ scope: 'project', name: 'tool', fingerprint: FP }] }, 'repo is required for project and local servers, and only for them'],
      [{ mcpAllow: [{ scope: 'user', name: 'github', repo: '/r', fingerprint: FP }] }, 'repo is required for project and local servers, and only for them'],
      [{ mcpAllow: [{ scope: 'user', name: '', fingerprint: FP }] }, 'an MCP server name cannot be empty'],
      [{ mcpAllow: [{ scope: 'user', name: 'x'.repeat(201), fingerprint: FP }] }, 'an MCP server name can be at most 200 characters'],
      [{ mcpAllow: [{ scope: 'user', name: 'github', fingerprint: FP, extra: 1 }] }, 'unknown setting: extra'],
    ] as const) {
      const res = await put(ctx.app, JSON.stringify(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: error });
    }
    expect((await put(ctx.app, 'not json')).status).toBe(400);
    expect(ctx.orch.maxAgents).toBe(8);
    const reset = await put(ctx.app, JSON.stringify({ maxAgents: null }));
    expect(await reset.json()).toMatchObject({ maxAgents: 3, limits: { maxAgents: { default: 3 } } });
    expect(ctx.store.settings()).toEqual({});
    // Writes must be JSON, like every other (the CSRF guard).
    const form = await ctx.app.request('/api/settings', { method: 'PUT', headers: LOCAL, body: 'maxAgents=2' });
    expect(form.status).toBe(415);
  });

  it('saves the MCP switch and allowlist: off and empty by default, names trimmed and each once', () => {
    const store = openStore(':memory:');
    const settings = new SavedSettings(store);
    expect(settings.get()).toMatchObject({ useUserMcp: false, mcpAllow: [] });
    const github = { scope: 'user', name: 'github', fingerprint: FP } as const;
    const docs = { scope: 'claudeai', name: 'claude.ai Claude Docs', fingerprint: FP } as const;
    const repoTool = { scope: 'project', name: 'tool', repo: '/work/repo', fingerprint: FP } as const;
    // The same server twice is kept once (the first); one name in two scopes is two servers.
    const saved = settings.update({ useUserMcp: true, mcpAllow: [github, docs, { ...github, fingerprint: 'ffffffffffffffff' }, repoTool, { ...repoTool, scope: 'local' }] });
    expect(saved).toMatchObject({ useUserMcp: true, mcpAllow: [github, docs, repoTool, { ...repoTool, scope: 'local' }] });
    expect(new SavedSettings(store).get().mcpAllow).toEqual([github, docs, repoTool, { ...repoTool, scope: 'local' }]);
    // An allowlist saved by name only (before servers were allowed by what they are) counts for nothing.
    store.setSettings({ mcpAllow: ['github'] });
    expect(new SavedSettings(store).get().mcpAllow).toEqual([]);
    settings.update({ mcpAllow: [github] });
    expect(settings.update({ useUserMcp: null, mcpAllow: null })).toMatchObject({ useUserMcp: false, mcpAllow: [] });
    expect(store.settings()).toEqual({});
  });

  it('streams the settings on connect and on every change', async () => {
    const ctx = start();
    const res = await ctx.app.request('/api/events', { headers: LOCAL });
    const reader = res.body!.getReader();
    let text = '';
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += new TextDecoder().decode(value);
      }
    })();
    await waitFor(() => text.includes('event: settings\ndata: {"maxAgents":4,"autoResume":true,"useUserMcp":false,"mcpAllow":[],"delegation":"balanced"}'));
    await put(ctx.app, JSON.stringify({ maxAgents: 12 }));
    await waitFor(() => text.includes('event: settings\ndata: {"maxAgents":12,"autoResume":true,"useUserMcp":false,"mcpAllow":[],"delegation":"balanced"}'));
    await put(ctx.app, JSON.stringify({ autoResume: false }));
    await waitFor(() => text.includes('event: settings\ndata: {"maxAgents":12,"autoResume":false,"useUserMcp":false,"mcpAllow":[],"delegation":"balanced"}'));
    await reader.cancel();
    await pump.catch(() => {});
  });

  it('gives new round-ups the default delegation level, unless the request picks one, and lets each change its own', async () => {
    const ctx = start();
    const setDelegation = vi.spyOn(ctx.orch, 'setDelegation');
    const post = (body: unknown) => ctx.app.request('/api/sessions', { method: 'POST', headers: { ...LOCAL, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const patch = (id: string, body: unknown) =>
      ctx.app.request(`/api/sessions/${id}`, { method: 'PATCH', headers: { ...LOCAL, 'content-type': 'application/json' }, body: JSON.stringify(body) });

    // Balanced until the person picks another default.
    expect(await (await post({})).json()).toMatchObject({ delegation: 'balanced' });
    const saved = await put(ctx.app, JSON.stringify({ delegation: 'solo' }));
    expect(await saved.json()).toMatchObject({ delegation: 'solo' });
    expect(ctx.store.settings()).toEqual({ delegation: 'solo' });
    const solo = (await (await post({})).json()) as { id: string; delegation: string };
    expect(solo.delegation).toBe('solo');
    expect(ctx.store.getSession(solo.id)?.delegation).toBe('solo');
    expect(await (await post({ delegation: 'delegate' })).json()).toMatchObject({ delegation: 'delegate' });
    expect(await (await post({ delegation: 'all' })).json()).toEqual({ error: 'delegation must be one of: solo, balanced, delegate' });
    expect(await (await put(ctx.app, JSON.stringify({ delegation: 'all' }))).json()).toEqual({ error: 'delegation must be one of solo, balanced, delegate' });

    // A round-up's own level: saved, shown, and passed to the orchestrator only when it changes.
    const changed = await patch(solo.id, { delegation: 'delegate' });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ delegation: 'delegate' });
    expect(ctx.store.getSession(solo.id)?.delegation).toBe('delegate');
    expect(setDelegation).toHaveBeenCalledExactlyOnceWith(solo.id, 'delegate');
    expect((await patch(solo.id, { delegation: 'delegate' })).status).toBe(200);
    expect(setDelegation).toHaveBeenCalledOnce();
    const bad = await patch(solo.id, { delegation: 'none', title: 'Kept' });
    expect(bad.status).toBe(400);
    expect(ctx.sessions.get(solo.id)?.info()).toMatchObject({ delegation: 'delegate', title: '' });
    // Sub-agents follow their round-up's.
    const agent = ctx.sessions.create(tmpdir(), { parentId: solo.id, role: 'agent' });
    expect(agent.info().delegation).toBe('delegate');
    expect(await (await patch(agent.id, { delegation: 'solo' })).json()).toEqual({ error: "a sub-agent follows its round-up's delegation level" });

    // Changing the default leaves round-ups made before it alone.
    await put(ctx.app, JSON.stringify({ delegation: null }));
    expect(ctx.orch.settings.get().delegation).toBe('balanced');
    expect(ctx.sessions.get(solo.id)?.delegation).toBe('delegate');
  });
});
