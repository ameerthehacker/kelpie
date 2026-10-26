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
    expect(first.get()).toEqual({ maxAgents: 4, autoResume: true });
    expect(first.update({ maxAgents: 9 })).toEqual({ maxAgents: 9, autoResume: true });
    store.close();
    store = openStore(db);
    expect(store.settings()).toEqual({ maxAgents: 9 });
    expect(new SavedSettings(store).get()).toEqual({ maxAgents: 9, autoResume: true });
    // A saved setting wins over the one Kelpie was started with (KELPIE_MAX_AGENTS).
    expect(new SavedSettings(store, { maxAgents: 2 }).get()).toEqual({ maxAgents: 9, autoResume: true });
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
    expect(settings.get()).toEqual({ maxAgents: 4, autoResume: true });
    expect(changed).not.toHaveBeenCalled();
    settings.update({ maxAgents: 16 });
    expect(changed).toHaveBeenCalledWith({ maxAgents: 16, autoResume: true }, { maxAgents: 4, autoResume: true });
  });

  it('forgets a saved limit on null, so the default (KELPIE_MAX_AGENTS) applies again', () => {
    const store = openStore(':memory:');
    const settings = new SavedSettings(store, { maxAgents: 6 });
    settings.update({ maxAgents: 2 });
    expect(store.settings()).toEqual({ maxAgents: 2 });
    expect(settings.update({ maxAgents: null })).toEqual({ maxAgents: 6, autoResume: true });
    expect(store.settings()).toEqual({});
    expect(new SavedSettings(store, { maxAgents: 9 }).get().maxAgents).toBe(9);
  });

  it('serves the settings with their range, and validates changes', async () => {
    const ctx = start(undefined, 3);
    const got = await ctx.app.request('/api/settings', { headers: LOCAL });
    // The default a reset puts back is the one Kelpie was started with.
    expect(await got.json()).toEqual({ maxAgents: 3, autoResume: true, limits: { maxAgents: { min: 1, max: 16, default: 3 } } });

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
      [{}, 'nothing to change: send maxAgents or autoResume'],
      [{ autoResume: 'yes' }, 'autoResume must be true or false'],
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
    await waitFor(() => text.includes('event: settings\ndata: {"maxAgents":4,"autoResume":true}'));
    await put(ctx.app, JSON.stringify({ maxAgents: 12 }));
    await waitFor(() => text.includes('event: settings\ndata: {"maxAgents":12,"autoResume":true}'));
    await put(ctx.app, JSON.stringify({ autoResume: false }));
    await waitFor(() => text.includes('event: settings\ndata: {"maxAgents":12,"autoResume":false}'));
    await reader.cancel();
    await pump.catch(() => {});
  });
});
