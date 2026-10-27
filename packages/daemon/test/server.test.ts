import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '@kelpie/store';
import { createApp, safeName, SessionManager } from '../src/index.js';
import { commit, lines, roundUp, setup as gitSetup, writer } from './review-fixtures.js';

const FAKE = join(import.meta.dirname, '../../adapters/test/fake-claude.mjs');
const FIXTURE = join(import.meta.dirname, '../../adapters/fixtures/claude-code/plain.jsonl');
chmodSync(FAKE, 0o755);

const local = { host: '127.0.0.1:7317', 'content-type': 'application/json' };

const manager = (defaultCwd = tmpdir()) =>
  new SessionManager({
    store: openStore(':memory:'),
    defaultCwd,
    runsDir: mkdtempSync(join(tmpdir(), 'kelpie-runs-')),
    defaults: { bin: FAKE, env: { FAKE_FIXTURE: FIXTURE } },
  });

function setup() {
  const sessions = manager();
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
    const app = createApp(manager(root));
    const res = await app.request('/api/sessions', { method: 'POST', headers: local, body: '{"cwd":"sub"}' });
    expect(((await res.json()) as { cwd: string }).cwd).toBe(join(root, 'sub'));
    expect((await app.request('/api/sessions', { method: 'POST', headers: local, body: '{"cwd":3}' })).status).toBe(400);
  });

  it('answers unknown API paths with a JSON 404, not the UI page', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'kelpie-dist-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html>');
    const app = createApp(manager(), { staticDir: dist });
    const res = await app.request('/api/sessions/abc/event', { headers: { host: local.host } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
    expect(await (await app.request('/some/page', { headers: { host: local.host } })).text()).toBe('<!doctype html>');
  });
});

describe('round-up API', () => {
  const json = (body: unknown) => ({ headers: local, body: JSON.stringify(body) });
  const create = async (app: ReturnType<typeof createApp>) =>
    ((await (await app.request('/api/sessions', { method: 'POST', ...json({}) })).json()) as { id: string }).id;

  it('renames and deletes a round-up', async () => {
    const { app } = setup();
    const id = await create(app);
    const renamed = await app.request(`/api/sessions/${id}`, { method: 'PATCH', ...json({ title: '  Fix   the build ' }) });
    expect(await renamed.json()).toMatchObject({ id, title: 'Fix the build', titleSource: 'person' });
    // Clearing the person's title gives the round-up back its first message (none yet here), and AI titles resume.
    const cleared = await app.request(`/api/sessions/${id}`, { method: 'PATCH', ...json({ title: ' ' }) });
    expect(await cleared.json()).toMatchObject({ id, title: '' });
    expect((await app.request(`/api/sessions/${id}`, { method: 'PATCH', ...json({ title: 42 }) })).status).toBe(400);
    expect((await app.request(`/api/sessions/${id}`, { method: 'PATCH', ...json({ title: 'x'.repeat(201) }) })).status).toBe(400);
    expect((await app.request(`/api/sessions/${id}`, { method: 'DELETE', headers: local })).status).toBe(204);
    expect((await app.request(`/api/sessions/${id}`, { headers: local })).status).toBe(404);
    expect((await app.request(`/api/sessions/${id}`, { method: 'DELETE', headers: local })).status).toBe(404);
  });

  it('sets a round-up’s model when it is created, changes it, and puts the default back', async () => {
    const { app } = setup();
    const res = await app.request('/api/sessions', { method: 'POST', ...json({ model: 'opus' }) });
    const { id, model } = (await res.json()) as { id: string; model?: string };
    expect(model).toBe('opus');
    const patch = (body: unknown) => app.request(`/api/sessions/${id}`, { method: 'PATCH', ...json(body) });
    expect(await (await patch({ model: 'claude-sonnet-5-5' })).json()).toMatchObject({ model: 'claude-sonnet-5-5' });
    expect(await (await patch({ model: null })).json()).not.toHaveProperty('model');
    expect((await patch({ model: '--dangerously-skip-permissions' })).status).toBe(400);
    expect((await app.request('/api/sessions', { method: 'POST', ...json({ model: 'a b' }) })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
  });

  it('sets a round-up’s effort when it is created, changes it, and puts the default back', async () => {
    const { app } = setup();
    const res = await app.request('/api/sessions', { method: 'POST', ...json({ effort: 'high' }) });
    const { id, effort } = (await res.json()) as { id: string; effort?: string };
    expect(effort).toBe('high');
    const patch = (body: unknown) => app.request(`/api/sessions/${id}`, { method: 'PATCH', ...json(body) });
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) expect(await (await patch({ effort: level })).json()).toMatchObject({ effort: level });
    expect(await (await patch({ effort: null })).json()).not.toHaveProperty('effort');
    expect((await patch({ effort: 'ultra' })).status).toBe(400);
    expect((await patch({ effort: '--model' })).status).toBe(400);
    expect((await app.request('/api/sessions', { method: 'POST', ...json({ effort: 3 }) })).status).toBe(400);
  });

  it('sets a round-up’s mode when it is created and changes it, among the modes its harness has', async () => {
    const { app } = setup();
    expect(await (await app.request('/api/harnesses', { headers: local })).json()).toEqual([{ harness: 'claude-code', modes: ['auto', 'acceptEdits', 'plan'] }]);
    const created = await app.request('/api/sessions', { method: 'POST', ...json({ mode: 'plan' }) });
    const { id, mode } = (await created.json()) as { id: string; mode: string };
    expect(mode).toBe('plan');
    expect(((await (await app.request('/api/sessions', { method: 'POST', ...json({}) })).json()) as { mode: string }).mode).toBe('auto');
    const patch = (body: unknown) => app.request(`/api/sessions/${id}`, { method: 'PATCH', ...json(body) });
    expect(await (await patch({ mode: 'acceptEdits' })).json()).toMatchObject({ mode: 'acceptEdits' });
    expect((await patch({ mode: 'yolo' })).status).toBe(400);
    expect((await app.request('/api/sessions', { method: 'POST', ...json({ mode: 'yolo' }) })).status).toBe(400);
  });

  it('ends open event streams when the round-up is deleted', async () => {
    const { app } = setup();
    const id = await create(app);
    const res = await app.request(`/api/sessions/${id}/events`, { headers: { host: local.host } });
    const reader = res.body!.getReader();
    await app.request(`/api/sessions/${id}`, { method: 'DELETE', headers: local });
    let done = false;
    while (!done) done = (await reader.read()).done;
    expect(done).toBe(true);
  });

  it('streams the round-up list: a snapshot, then changes', async () => {
    const { app, sessions } = setup();
    const first = await create(app);
    const res = await app.request('/api/events', { headers: { host: local.host } });
    const reader = res.body!.getReader();
    let text = '';
    const until = async (needle: string) => {
      while (!text.includes(needle)) text += new TextDecoder().decode((await reader.read()).value);
    };
    await until('event: sessions');
    const second = await create(app);
    await until(`"id":"${second}"`);
    await app.request(`/api/sessions/${second}/messages`, { method: 'POST', ...json({ text: 'What is 2+2?' }) });
    await until('"lastTurn":"completed"');
    await app.request(`/api/sessions/${first}`, { method: 'DELETE', headers: local });
    await until('event: deleted');
    await reader.cancel();
    await sessions.stopAll();

    expect(text).toMatch(new RegExp(`event: sessions\ndata: \\[\\{"id":"${first}"`));
    expect(text).toContain('"title":"What is 2+2?"');
    expect(text).toContain(`event: deleted\ndata: {"id":"${first}"}`);
    expect(text).toMatch(/^event: usage\ndata: \[\]$/m); // nothing reported yet on connect
    expect(text).toMatch(/^event: usage\ndata: \[\{"harness":"claude-code","usage":\{"status":"allowed".*"seven_day":\{"utilization":/m);
    const usage = (await (await app.request('/api/usage', { headers: { host: local.host } })).json()) as { harness: string }[];
    expect(usage.map((u) => u.harness)).toEqual(['claude-code']);
  });

  it('snapshots sub-agents apart from the round-up list', async () => {
    const { app, sessions } = setup();
    const parent = sessions.create();
    const child = sessions.create(undefined, { parentId: parent.id, role: 'agent', title: 'Checkout API' });
    const res = await app.request('/api/events', { headers: { host: local.host } });
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('event: approvals-snapshot')) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();

    const data = (event: string) => JSON.parse(new RegExp(`^event: ${event}\ndata: (.*)$`, 'm').exec(text)![1]!) as { id: string; parentId?: string; busy: boolean }[];
    expect(data('sessions').map((s) => s.id)).toEqual([parent.id]);
    expect(data('sub-agents')).toEqual([expect.objectContaining({ id: child.id, parentId: parent.id, busy: false })]);
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

describe('uploads', () => {
  const STDIN = () => join(mkdtempSync(join(tmpdir(), 'kelpie-stdin-')), 'stdin.jsonl');

  function withScratch(maxUploadBytes?: number) {
    const stdin = STDIN();
    const sessions = new SessionManager({
      store: openStore(':memory:'),
      defaultCwd: tmpdir(),
      runsDir: mkdtempSync(join(tmpdir(), 'kelpie-runs-')),
      scratchDir: mkdtempSync(join(tmpdir(), 'kelpie-scratch-')),
      defaults: { bin: FAKE, env: { FAKE_FIXTURE: FIXTURE, FAKE_STDIN_FILE: stdin } },
    });
    return { sessions, stdin, app: createApp(sessions, maxUploadBytes ? { maxUploadBytes } : {}) };
  }
  const upload = (app: ReturnType<typeof createApp>, id: string, bytes: string, headers: Record<string, string> = {}) =>
    app.request(`/api/sessions/${id}/uploads`, {
      method: 'POST',
      headers: { host: local.host, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('my shot.png'), 'x-file-type': 'image/png', ...headers },
      body: bytes,
    });

  it('saves a file to the round-up scratch folder, serves it back, and lists it in a message by path', async () => {
    const { app, sessions, stdin } = withScratch();
    const session = sessions.create();
    const res = await upload(app, session.id, 'PNGDATA');
    expect(res.status).toBe(201);
    const file = (await res.json()) as { id: string; name: string; mime: string; size: number };
    expect(file).toMatchObject({ name: 'my shot.png', mime: 'image/png', size: 7 });

    const [row] = sessions.uploads(session, [file.id]);
    expect(row!.path.startsWith(join(session.scratch!, 'uploads'))).toBe(true);
    expect(row!.path).toMatch(/-my-shot\.png$/);
    expect(readFileSync(row!.path, 'utf8')).toBe('PNGDATA');

    const got = await app.request(`/api/sessions/${session.id}/uploads/${file.id}`, { headers: { host: local.host } });
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await got.text()).toBe('PNGDATA');

    const sent = await app.request(`/api/sessions/${session.id}/messages`, { method: 'POST', headers: local, body: JSON.stringify({ text: 'What is this?', attachments: [file.id] }) });
    expect(sent.status).toBe(202);
    const echo = await (async () => {
      for (let i = 0; i < 250; i++) {
        const e = session.events().find((ev) => ev.kind === 'message' && ev.data.sent);
        if (e) return e;
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    await sessions.stopAll();
    // The harness got the paths in the turn itself; the echo carries the files for the UI.
    const turn = JSON.parse(readFileSync(stdin, 'utf8').split('\n')[0]!).text as string;
    expect(turn).toBe(`What is this?\n\n<attachments>\n- ${row!.path} (image/png, 7 B)\n</attachments>`);
    expect(echo?.kind === 'message' && echo.data.attachments).toEqual([{ id: file.id, name: 'my shot.png', mime: 'image/png', size: 7 }]);
    expect(session.title).toBe('What is this?');
  });

  it('sends files without text, titled after them', async () => {
    const { app, sessions } = withScratch();
    const session = sessions.create();
    const { id } = (await (await upload(app, session.id, 'x')).json()) as { id: string };
    expect((await app.request(`/api/sessions/${session.id}/messages`, { method: 'POST', headers: local, body: JSON.stringify({ attachments: [id] }) })).status).toBe(202);
    await sessions.stopAll();
    expect(session.title).toBe('my shot.png');
  });

  it('downloads anything that is not an image or PDF instead of showing it', async () => {
    const { app, sessions } = withScratch();
    const session = sessions.create();
    const { id } = (await (await upload(app, session.id, '<svg onload=alert(1)>', { 'x-file-name': 'a.svg', 'x-file-type': 'image/svg+xml' })).json()) as { id: string };
    const got = await app.request(`/api/sessions/${session.id}/uploads/${id}`, { headers: { host: local.host } });
    expect(got.headers.get('content-type')).toBe('application/octet-stream');
    expect(got.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('refuses bad uploads and unknown attachments', async () => {
    const { app, sessions } = withScratch(10);
    const a = sessions.create();
    const b = sessions.create();
    expect((await upload(app, a.id, 'way more than ten bytes')).status).toBe(413);
    expect((await upload(app, a.id, 'x', { 'x-file-name': '' })).status).toBe(400);
    expect((await upload(app, a.id, '')).status).toBe(400);
    expect((await upload(app, a.id, 'x', { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await upload(app, 'nope', 'x')).status).toBe(404);
    // Another round-up's upload is not this one's to send.
    const { id } = (await (await upload(app, b.id, 'x')).json()) as { id: string };
    const send = (attachments: unknown) => app.request(`/api/sessions/${a.id}/messages`, { method: 'POST', headers: local, body: JSON.stringify({ text: 'hi', attachments }) });
    expect((await send([id])).status).toBe(400);
    expect((await send('nope')).status).toBe(400);
    expect((await app.request(`/api/sessions/${a.id}/uploads/${id}`, { headers: { host: local.host } })).status).toBe(404);
  });

  it('keeps names on disk safe, and removes the scratch folder with its round-up', async () => {
    const { app, sessions } = withScratch();
    const session = sessions.create();
    const { id } = (await (await upload(app, session.id, 'x', { 'x-file-name': encodeURIComponent('../../etc/pa$$wd') })).json()) as { id: string };
    const [row] = sessions.uploads(session, [id]);
    expect(row!.path).toBe(join(session.scratch!, 'uploads', `${id.slice(0, 8)}-pa-wd`));
    expect(row!.name).toBe('../../etc/pa$$wd');
    await sessions.delete(session.id);
    expect(existsSync(session.scratch!)).toBe(false);
  });

  it('keeps names readable in any script, and always keeps the extension', () => {
    expect(safeName('截图.png')).toBe('截图.png');
    expect(safeName('my shot (1).PNG')).toBe('my-shot-1-.PNG');
    expect(safeName('.env')).toBe('env');
    expect(safeName('$$$.pdf')).toBe('file.pdf');
  });

  it('serves an SVG as a download whatever case its type is given in', async () => {
    const { app, sessions } = withScratch();
    const session = sessions.create();
    const { id, mime } = (await (await upload(app, session.id, '<svg/>', { 'x-file-name': 'a.svg', 'x-file-type': 'image/SVG+XML' })).json()) as { id: string; mime: string };
    expect(mime).toBe('image/svg+xml');
    const got = await app.request(`/api/sessions/${session.id}/uploads/${id}`, { headers: { host: local.host } });
    expect(got.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('leaves nothing behind when the round-up is deleted while a file is being saved', async () => {
    const { sessions } = withScratch();
    const session = sessions.create();
    const saving = sessions.saveUpload(session, { name: 'a.txt', mime: 'text/plain', bytes: new Uint8Array([1]) });
    // Watched from the start: it may fail before the deletion finishes, and must not go unhandled meanwhile.
    const refused = expect(saving).rejects.toThrow(/deleted/);
    await sessions.delete(session.id);
    await refused;
    expect(existsSync(session.scratch!)).toBe(false);
  });

  it('turns uploads away when Kelpie keeps no scratch folder', async () => {
    const { app, sessions } = setup();
    expect((await upload(app, sessions.create().id, 'x')).status).toBe(400);
  });
});

describe('changes and review API', () => {
  it('is not there without an orchestrator', async () => {
    const { app, sessions } = setup();
    const id = sessions.create().id;
    for (const path of ['changes', 'changes/file?path=a', 'review']) expect((await app.request(`/api/sessions/${id}/${path}`, { headers: local })).status).toBe(404);
    expect((await app.request(`/api/sessions/${id}/review/submit`, { method: 'POST', headers: local, body: '{"verdict":"approve"}' })).status).toBe(404);
  });

  it('checks every request, and refuses a review while Kelpie shuts down', async () => {
    const ctx = gitSetup();
    try {
      const parent = await roundUp(ctx);
      const api = await writer(ctx, parent, 'API');
      commit(api.cwd, 'app.txt', lines({ 2: 'L2 api' }));
      await ctx.orch.muster(parent, [api.id]);
      const r = (path: string) => `/api/sessions/${parent.id}/${path}`;
      const head = (await ctx.api('GET', r('changes'))).body.headSha as string;

      // Unknown sessions, threads, comments and files.
      expect((await ctx.api('GET', '/api/sessions/nope/changes')).status).toBe(404);
      expect((await ctx.api('GET', '/api/sessions/nope/review')).status).toBe(404);
      expect((await ctx.api('GET', r('changes/file?path=nope.txt'))).status).toBe(404);
      expect((await ctx.api('POST', r('review/comments'), { threadId: 'nope', body: 'x' })).status).toBe(404);
      expect((await ctx.api('PATCH', r('review/comments/nope'), { body: 'x' })).status).toBe(404);
      expect((await ctx.api('DELETE', r('review/comments/nope'))).status).toBe(404);
      expect((await ctx.api('POST', r('review/threads/nope/resolve'), { resolved: true })).status).toBe(404);
      const anchor = { view: 'feature', path: 'app.txt', side: 'additions', line: 2, commitSha: head, lineText: 'L2 api' };
      expect((await ctx.api('POST', r('review/comments'), { anchor: { ...anchor, view: 'agent', viewSessionId: 'nope' }, body: 'x' })).status).toBe(404);

      // Malformed ones.
      expect((await ctx.api('GET', r('changes?round=0'))).status).toBe(400);
      expect((await ctx.api('GET', r('changes/file'))).status).toBe(400);
      expect((await ctx.api('GET', `/api/sessions/${api.id}/changes?round=7`))).toMatchObject({ status: 400, body: { error: expect.stringMatching(/no round 7/) } });
      expect((await ctx.api('POST', r('review/comments'), { body: 'x' })).status).toBe(400);
      expect((await ctx.api('POST', r('review/comments'), { anchor: { ...anchor, side: 'left' }, body: 'x' })).status).toBe(400);
      expect((await ctx.api('POST', r('review/comments'), { anchor: { ...anchor, line: 0 }, body: 'x' })).status).toBe(400);
      expect((await ctx.api('POST', r('review/comments'), { anchor, body: '' })).status).toBe(400);
      expect((await ctx.api('POST', r('review/comments'), { anchor, body: 'x'.repeat(10_001) })).status).toBe(400);
      expect((await ctx.api('POST', r('review/submit'), { verdict: 'lgtm' })).status).toBe(400);
      expect((await ctx.api('POST', r('review/submit'), { verdict: 'request_changes' })).body).toEqual({ error: expect.stringMatching(/comment or a summary/) });
      expect((await ctx.api('POST', r('review/submit'), { verdict: 'comment', body: '   ' })).status).toBe(400);

      // A thread in the draft: edited and deleted while pending; resolving waits for the submit.
      const made = await ctx.api('POST', r('review/comments'), { anchor, body: 'first' });
      expect(made.status).toBe(201);
      const commentId = made.body.thread.comments[0].id as string;
      const threadId = made.body.thread.id as string;
      expect((await ctx.api('PATCH', r(`review/comments/${commentId}`), { body: 'better' })).body).toMatchObject({ id: commentId, body: 'better', state: 'pending' });
      expect((await ctx.api('PATCH', r(`review/comments/${commentId}`), { body: '' })).status).toBe(400);
      expect((await ctx.api('POST', r(`review/threads/${threadId}/resolve`), { resolved: true })).status).toBe(409);
      expect((await ctx.api('POST', r(`review/threads/${threadId}/resolve`), { resolved: 'yes' })).status).toBe(400);
      expect((await ctx.api('DELETE', r(`review/comments/${commentId}`))).status).toBe(204);
      expect((await ctx.api('GET', r('review'))).body.threads).toEqual([]);
      const again = await ctx.api('POST', r('review/comments'), { anchor, body: 'again' });
      expect((await ctx.api('DELETE', r('review/pending'))).status).toBe(204);
      expect((await ctx.api('GET', r('review'))).body).toMatchObject({ pending: null, threads: [] });
      expect(again.status).toBe(201);

      // Submitted: a published comment no longer changes; the person resolves and reopens.
      const kept = await ctx.api('POST', r('review/comments'), { anchor, body: 'kept' });
      expect((await ctx.api('POST', r('review/submit'), { verdict: 'comment' })).status).toBe(200);
      expect((await ctx.api('PATCH', r(`review/comments/${kept.body.thread.comments[0].id}`), { body: 'x' })).status).toBe(409);
      expect((await ctx.api('DELETE', r(`review/comments/${kept.body.thread.comments[0].id}`))).status).toBe(409);
      const resolved = await ctx.api('POST', r(`review/threads/${kept.body.thread.id}/resolve`), { resolved: true });
      expect(resolved.body).toMatchObject({ status: 'resolved', resolvedBy: 'person' });
      expect((await ctx.api('POST', r(`review/threads/${kept.body.thread.id}/resolve`), { resolved: false })).body).toMatchObject({ status: 'open' });
      expect((await ctx.api('GET', `/api/sessions/${parent.id}/changes/file?path=app.txt`)).body).toMatchObject({ path: 'app.txt', patch: expect.stringContaining('+L2 api') });

      ctx.sessions.prepareShutdown();
      expect(await ctx.api('POST', r('review/submit'), { verdict: 'approve' })).toEqual({ status: 409, body: { error: 'Kelpie is shutting down' } });
      expect((await ctx.api('GET', r('review'))).body).toMatchObject({ pending: null, reviews: [{ verdict: 'comment' }] });
    } finally {
      await ctx.sessions.stopAll();
    }
  });
});
