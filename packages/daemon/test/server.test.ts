import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp, SessionManager } from '../src/index.js';

const FAKE = join(import.meta.dirname, '../../adapters/test/fake-claude.mjs');
const FIXTURE = join(import.meta.dirname, '../../adapters/fixtures/claude-code/plain.jsonl');
chmodSync(FAKE, 0o755);

const local = { host: '127.0.0.1:7317', 'content-type': 'application/json' };

function setup() {
  const sessions = new SessionManager(tmpdir(), { bin: FAKE, env: { FAKE_FIXTURE: FIXTURE } });
  return { sessions, app: createApp(sessions) };
}

describe('local-only guard', () => {
  const { app } = setup();
  const post = (headers: Record<string, string>) => app.request('/api/sessions', { method: 'POST', headers, body: '{}' });

  it('accepts local pages', async () => {
    expect((await post(local)).status).toBe(201);
    expect((await post({ ...local, origin: 'http://localhost:5173' })).status).toBe(201);
  });

  it('rejects a rebinding host, a foreign origin, and non-JSON writes', async () => {
    expect((await post({ ...local, host: 'evil.example:7317' })).status).toBe(403);
    expect((await post({ ...local, origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ ...local, 'content-type': 'text/plain' })).status).toBe(415);
  });
});

describe('chat API', () => {
  it('sends a message and streams the KEF events back over SSE', async () => {
    const { app, sessions } = setup();
    const created = await app.request('/api/sessions', { method: 'POST', headers: local, body: '{}' });
    const { id } = (await created.json()) as { id: string };

    const sent = await app.request(`/api/sessions/${id}/messages`, { method: 'POST', headers: local, body: JSON.stringify({ text: 'What is 2+2?' }) });
    expect(sent.status).toBe(202);

    const res = await app.request(`/api/sessions/${id}/events`, { headers: { host: local.host } });
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('"kind":"turn.ended"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    await sessions.stopAll();

    const kinds = [...text.matchAll(/"kind":"([^"]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(['activity', 'session.started', 'message', 'message', 'rate_limit', 'usage', 'turn.ended']);
    expect(text).toMatch(/^event: kef\ndata: .*\nid: 0$/m);
    expect(text).not.toMatch(/"busy":false/); // idle only comes after turn.ended, never ahead of it
  });

  it('rejects empty messages and unknown sessions', async () => {
    const { app } = setup();
    const { id } = (await (await app.request('/api/sessions', { method: 'POST', headers: local, body: '{}' })).json()) as { id: string };
    expect((await app.request(`/api/sessions/${id}/messages`, { method: 'POST', headers: local, body: '{"text":"  "}' })).status).toBe(400);
    expect((await app.request('/api/sessions/nope/messages', { method: 'POST', headers: local, body: '{"text":"hi"}' })).status).toBe(404);
  });

  it('resolves a relative cwd against the default repo, not the daemon process cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kelpie-repo-'));
    mkdirSync(join(root, 'sub'));
    const app = createApp(new SessionManager(root));
    const res = await app.request('/api/sessions', { method: 'POST', headers: local, body: '{"cwd":"sub"}' });
    expect(((await res.json()) as { cwd: string }).cwd).toBe(join(root, 'sub'));
    expect((await app.request('/api/sessions', { method: 'POST', headers: local, body: '{"cwd":3}' })).status).toBe(400);
  });

  it('answers unknown API paths with a JSON 404, not the UI page', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'kelpie-dist-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html>');
    const app = createApp(new SessionManager(tmpdir()), { staticDir: dist });
    const res = await app.request('/api/sessions/abc/event', { headers: { host: local.host } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
    expect(await (await app.request('/some/page', { headers: { host: local.host } })).text()).toBe('<!doctype html>');
  });
});

describe('Session', () => {
  it('keeps delivering events when a subscriber throws', async () => {
    const { sessions } = setup();
    const session = sessions.create();
    const seen: string[] = [];
    session.subscribe(() => {
      throw new Error('bad subscriber');
    });
    const ended = new Promise<void>((done) =>
      session.subscribe(({ event }) => {
        seen.push(event.kind);
        if (event.kind === 'turn.ended') done();
      }),
    );
    const errors = console.error;
    console.error = () => {};
    try {
      session.send('What is 2+2?');
      await ended;
    } finally {
      console.error = errors;
      await sessions.stopAll();
    }
    expect(seen).toContain('message');
  });
});
