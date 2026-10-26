import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE, type SSEMessage } from 'hono/streaming';
import { getMimeType } from 'hono/utils/mime';
import { Answers, Mode } from '@kelpie/protocol';
import { isLocalHost, isLocalOrigin } from './local.js';
import { handleMcp } from './orchestrator/mcp.js';
import { BaseFixedError, type Orchestrator } from './orchestrator/orchestrator.js';
import { ReviewError } from './errors.js';
import { NoSuchRound } from './review/changes.js';
import type { NewAnchor } from './review/reviews.js';
import type { SessionManager } from './sessions.js';


const MODEL_ERROR = 'model must be a model name or alias, like "sonnet" or "claude-opus-5-5"';
/** A model name or alias as the harness CLI takes it; never anything that could pass for a flag. */
const isModel = (m: unknown): m is string => typeof m === 'string' && /^[A-Za-z0-9][\w.:\[\]-]{0,79}$/.test(m);
const isMime = (m: string | undefined): m is string => !!m && m.length <= 100 && /^[\w.+-]+\/[\w.+-]+$/.test(m);
const MODE_ERROR = `mode must be one of: ${Mode.options.join(', ')}`;
const MAX_ATTACHMENTS = 20;
/** Uploads the browser may show in place: images (not SVG, which can carry script) and PDFs. */
const inline = (mime: string) => (mime.startsWith('image/') && mime !== 'image/svg+xml') || mime === 'application/pdf';

export interface AppOptions {
  /** Built web UI to serve at `/`. */
  staticDir?: string;
  /** Serves the kelpie MCP server (the orchestrator's tools) at `/mcp`. */
  orchestrator?: Orchestrator;
  /** Largest file one upload may be. Default 25 MB. */
  maxUploadBytes?: number;
}

/**
 * Only local pages may drive the API (see local.ts), and writes must be JSON, or raw bytes for
 * an upload: both force a CORS preflight, which we never grant.
 */
export const localOnly: MiddlewareHandler = async (c, next) => {
  if (!isLocalHost(c.req.header('host'))) return c.text('forbidden host', 403);
  const origin = c.req.header('origin');
  if (origin && !isLocalOrigin(origin)) return c.text('forbidden origin', 403);
  const type = c.req.header('content-type') ?? '';
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !type.startsWith('application/json') && !type.startsWith('application/octet-stream')) {
    return c.text('expected application/json', 415);
  }
  await next();
};

/**
 * An SSE response fed by `start`, which returns its unsubscribe and may call
 * `end` to close the stream from our side. Writes are chained so they never
 * interleave; a ping every 15s lets clients spot a dead connection.
 */
function sse(c: Context, start: (send: (m: SSEMessage) => void, end: () => void) => () => void): Response {
  return streamSSE(c, async (stream) => {
    let chain = Promise.resolve();
    const send = (m: SSEMessage) => {
      chain = chain.then(() => stream.writeSSE(m));
    };
    let open = true;
    let ended!: () => void;
    const endedP = new Promise<void>((resolve) => (ended = resolve));
    const stop = start(send, () => {
      open = false;
      ended();
    });
    stream.onAbort(() => {
      open = false;
      ended();
    });
    while (open) {
      await Promise.race([stream.sleep(15_000), endedP]);
      if (open) send({ event: 'ping', data: '' });
    }
    stop();
    await chain;
  });
}

const jsonBody = <T>(c: Context) => c.req.json<T>().catch(() => ({}) as T);

/** A review refusal as the API answers it; anything else is Kelpie's own failure. */
function reviewError(c: Context, err: unknown): Response {
  if (err instanceof ReviewError) return c.json({ error: err.message, ...(err.stale ? { stale: true } : {}) }, err.status);
  if (err instanceof NoSuchRound) return c.json({ error: err.message }, 400);
  throw err;
}

const VERDICTS = ['comment', 'request_changes', 'approve'] as const;

/** A new thread's anchor, as the web sends it; undefined if it isn't one. */
function anchorOf(a: unknown): NewAnchor | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const { view, viewSessionId, path, side, line, commitSha, lineText } = a as Record<string, unknown>;
  if (view !== 'feature' && view !== 'agent') return undefined;
  if (view === 'agent' && typeof viewSessionId !== 'string') return undefined;
  if (typeof path !== 'string' || !path || path.length > 4096) return undefined;
  if (side !== 'additions' && side !== 'deletions') return undefined;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return undefined;
  if (typeof commitSha !== 'string' || !/^[0-9a-f]{4,64}$/.test(commitSha)) return undefined;
  if (typeof lineText !== 'string' || lineText.length > 100_000) return undefined;
  return { view, ...(view === 'agent' ? { viewSessionId: viewSessionId as string } : {}), path, side, line, commitSha, lineText };
}

export function createApp(sessions: SessionManager, opts: AppOptions = {}): Hono {
  const app = new Hono();
  app.use('/api/*', localOnly);
  const orch = opts.orchestrator;
  if (orch) app.all('/mcp', (c) => handleMcp(c, orch));

  app.get('/api/health', (c) => c.json({ ok: true, defaultCwd: sessions.defaultCwd }));

  app.get('/api/sessions', (c) => c.json(sessions.list()));

  app.get('/api/usage', (c) => c.json(sessions.usage()));

  // What the harness offers a round-up: its modes, in the order Shift+Tab cycles through them.
  app.get('/api/harnesses', (c) => c.json(sessions.harnesses()));

  // Round-up list (and sub-agents), harness usage and approvals: snapshots, then every change.
  app.get('/api/events', (c) =>
    sse(c, (send) => {
      send({ event: 'sessions', data: JSON.stringify(sessions.list()) });
      // Sub-agents as they are now (their changes come as `session` too): who is still working.
      send({ event: 'sub-agents', data: JSON.stringify(sessions.all().filter((s) => s.parentId).map((s) => s.info())) });
      send({ event: 'usage', data: JSON.stringify(sessions.usage()) });
      send({ event: 'approvals-snapshot', data: JSON.stringify(sessions.approvals()) });
      return sessions.watch((u) => {
        if (u.type === 'session') send({ event: 'session', data: JSON.stringify(u.session) });
        else if (u.type === 'deleted') send({ event: 'deleted', data: JSON.stringify({ id: u.id }) });
        else if (u.type === 'agent') send({ event: 'agent', data: JSON.stringify(u.agent) });
        else if (u.type === 'approvals') send({ event: 'approvals', data: JSON.stringify({ roundUpId: u.roundUpId, approvals: u.approvals }) });
        else if (u.type === 'usage') send({ event: 'usage', data: JSON.stringify(u.usage) });
        else if (u.type === 'review') send({ event: 'review', data: JSON.stringify({ roundUpId: u.roundUpId, state: u.state }) });
        else if (u.type === 'changes') send({ event: 'changes', data: JSON.stringify({ roundUpId: u.roundUpId, sessionId: u.sessionId }) });
      });
    }),
  );

  app.post('/api/sessions', async (c) => {
    const body = await jsonBody<{ cwd?: unknown; model?: unknown; baseBranch?: unknown; mode?: unknown }>(c);
    if (body.cwd !== undefined && typeof body.cwd !== 'string') return c.json({ error: 'cwd must be a string' }, 400);
    if (body.model !== undefined && !isModel(body.model)) return c.json({ error: MODEL_ERROR }, 400);
    const mode = Mode.safeParse(body.mode ?? 'auto');
    if (!mode.success || !sessions.modes.includes(mode.data)) return c.json({ error: MODE_ERROR }, 400);
    if (body.baseBranch !== undefined && (typeof body.baseBranch !== 'string' || !orch)) return c.json({ error: 'baseBranch must be a branch name' }, 400);
    // Relative to the daemon's default repo, not its process cwd (a package dir under `pnpm dev`).
    const cwd = resolve(sessions.defaultCwd, body.cwd ?? '.');
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return c.json({ error: `not a directory: ${cwd}` }, 400);
    const session = sessions.create(cwd, { mode: mode.data, ...(body.model ? { model: body.model } : {}) });
    if (typeof body.baseBranch === 'string' && orch) {
      try {
        await orch.setBase(session, body.baseBranch);
      } catch (err) {
        await sessions.delete(session.id);
        return c.json({ error: (err as Error).message }, 400);
      }
    }
    return c.json(session.info(), 201);
  });

  // What round-ups are waiting on the person for: one round-up's (with its saved rules), or every one's.
  // `/api/events` sends an `approvals` event with a round-up's whole list whenever it changes.
  app.get('/api/approvals', (c) => {
    const roundUp = c.req.query('roundUp');
    if (roundUp && !sessions.get(roundUp)) return c.json({ error: 'no such session' }, 404);
    return c.json({ approvals: sessions.approvals(roundUp), ...(roundUp ? { rules: sessions.rules(roundUp) } : {}) });
  });

  // Answers a batch: { items: [{ sessionId, requestId }], decision: 'allow' | 'deny', message?, remember?, mode?, answers? }.
  // Each item is answered on its own; the result says which went through. Questions are allowed with
  // `answers` (question text → an option's label, the person's own words, or a list for a multi-select
  // one), one item at a time; denying them skips them.
  app.post('/api/approvals', async (c) => {
    const body = await jsonBody<{ items?: unknown; decision?: unknown; message?: unknown; remember?: unknown; mode?: unknown; answers?: unknown }>(c);
    const items = Array.isArray(body.items) ? body.items : [];
    const valid = items.length > 0 && items.length <= 500 && items.every((i) => typeof i?.sessionId === 'string' && typeof i?.requestId === 'string');
    if (!valid) return c.json({ error: 'items must be 1-500 { sessionId, requestId }' }, 400);
    if (body.decision !== 'allow' && body.decision !== 'deny') return c.json({ error: 'decision must be allow or deny' }, 400);
    if (body.message !== undefined && (typeof body.message !== 'string' || body.message.length > 2000)) return c.json({ error: 'message must be text (at most 2000 characters)' }, 400);
    const mode = body.mode === undefined ? undefined : Mode.safeParse(body.mode);
    if (mode && (!mode.success || mode.data === 'plan')) return c.json({ error: 'mode, approving a plan, must be auto or acceptEdits' }, 400);
    const answers = body.answers === undefined ? undefined : Answers.safeParse(body.answers);
    if (answers && (!answers.success || items.length !== 1 || body.decision !== 'allow')) {
      return c.json({ error: 'answers must map question text to an answer (or a list of them), for one item being allowed' }, 400);
    }
    if (answers) {
      const [item] = items as { sessionId: string; requestId: string }[];
      const pending = sessions.get(item!.sessionId)?.approval(item!.requestId);
      // Gone already is the result's to report; only a request still open can be the wrong kind.
      if (pending && !pending.questions) return c.json({ error: 'answers are for questions, and this is not a question' }, 400);
    }
    const results = await sessions.answerApprovals({
      items: items as { sessionId: string; requestId: string }[],
      allow: body.decision === 'allow',
      ...(typeof body.message === 'string' ? { message: body.message } : {}),
      remember: body.remember === true,
      ...(mode?.success ? { mode: mode.data } : {}),
      ...(answers?.success ? { answers: answers.data } : {}),
    });
    return c.json({ results });
  });

  // Forgets a rule saved for a round-up.
  app.delete('/api/sessions/:id/rules/:rule', (c) => {
    const s = sessions.get(c.req.param('id'));
    if (!s) return c.json({ error: 'no such session' }, 404);
    return sessions.deleteRule(s.roundUpId, Number(c.req.param('rule'))) ? c.body(null, 204) : c.json({ error: 'no such rule' }, 404);
  });

  // The branches a round-up may start from (remote first), for the composer's base-branch picker.
  app.get('/api/repo/branches', async (c) => {
    const cwd = resolve(sessions.defaultCwd, c.req.query('cwd') ?? '.');
    const branches = orch ? await orch.branchesAt(cwd) : undefined;
    return branches ? c.json({ cwd, branches }) : c.json({ error: `not a git repository: ${cwd}` }, 404);
  });

  app.get('/api/sessions/:id', (c) => {
    const s = sessions.get(c.req.param('id'));
    return s ? c.json(s.info()) : c.json({ error: 'no such session' }, 404);
  });

  // A round-up's sub-agents at a glance (each one's own log is at /api/sessions/:agentId/events);
  // `/api/events` then sends an `agent` event whenever one changes.
  app.get('/api/sessions/:id/agents', (c) => {
    if (!sessions.get(c.req.param('id'))) return c.json({ error: 'no such session' }, 404);
    return c.json(sessions.children(c.req.param('id')).map((s) => s.summary()));
  });

  app.patch('/api/sessions/:id', async (c) => {
    const s = sessions.get(c.req.param('id'));
    if (!s) return c.json({ error: 'no such session' }, 404);
    const body = await jsonBody<{ title?: unknown; model?: unknown; baseBranch?: unknown; mode?: unknown }>(c);
    if (body.title === undefined && body.model === undefined && body.baseBranch === undefined && body.mode === undefined) {
      return c.json({ error: 'nothing to change: send title, model, baseBranch or mode' }, 400);
    }
    const mode = body.mode === undefined ? undefined : Mode.safeParse(body.mode);
    if (mode && (!mode.success || !sessions.modes.includes(mode.data))) return c.json({ error: MODE_ERROR }, 400);
    if (mode && s.parentId) return c.json({ error: "a sub-agent follows its round-up's mode" }, 400);
    // Everything is checked before anything is saved: a bad field changes nothing.
    // Null puts the harness's default model back.
    if (body.model !== undefined && body.model !== null && !isModel(body.model)) return c.json({ error: MODEL_ERROR }, 400);
    const title = typeof body.title === 'string' ? body.title.trim().replace(/\s+/g, ' ') : '';
    if (body.title !== undefined && (!title || title.length > 200)) return c.json({ error: 'title must be 1-200 characters' }, 400);
    if (body.baseBranch !== undefined && (typeof body.baseBranch !== 'string' || !orch)) return c.json({ error: 'baseBranch must be a branch name' }, 400);
    if (typeof body.baseBranch === 'string' && orch) {
      try {
        await orch.setBase(s, body.baseBranch);
      } catch (err) {
        // Fixed once writers started from it (409); a bad or unknown branch is the request's fault (400).
        return c.json({ error: (err as Error).message }, err instanceof BaseFixedError ? 409 : 400);
      }
    }
    if (body.title !== undefined) s.rename(title);
    if (body.model !== undefined) s.setModel(body.model ?? undefined);
    if (mode?.success) await sessions.setMode(s, mode.data);
    return c.json(s.info());
  });

  app.delete('/api/sessions/:id', async (c) => {
    return (await sessions.delete(c.req.param('id'))) ? c.body(null, 204) : c.json({ error: 'no such session' }, 404);
  });

  // A file for the round-up's next message: the raw bytes, named by an `x-file-name` header (URI-encoded)
  // and typed by `x-file-type`. Send its id in the message's `attachments`.
  const maxUpload = opts.maxUploadBytes ?? 25 * 1024 * 1024;
  app.post(
    '/api/sessions/:id/uploads',
    bodyLimit({ maxSize: maxUpload, onError: (c) => c.json({ error: `a file can be at most ${Math.round(maxUpload / 1024 / 1024)} MB` }, 413) }),
    async (c) => {
      const s = sessions.get(c.req.param('id'));
      if (!s) return c.json({ error: 'no such session' }, 404);
      if (!c.req.header('content-type')?.startsWith('application/octet-stream')) return c.json({ error: 'send the file as application/octet-stream' }, 415);
      if (!s.scratch) return c.json({ error: 'uploads are not enabled' }, 400);
      let name = '';
      try {
        name = decodeURIComponent(c.req.header('x-file-name') ?? '').trim();
      } catch {}
      if (!name || name.length > 255) return c.json({ error: 'x-file-name must name the file (URI-encoded, at most 255 characters)' }, 400);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (!bytes.length) return c.json({ error: 'the file is empty' }, 400);
      // Lower case, as browsers compare types: the SVG check below must not be dodged by `image/SVG+XML`.
      const given = c.req.header('x-file-type')?.toLowerCase();
      const mime = isMime(given) ? given : (getMimeType(name) ?? 'application/octet-stream');
      const row = await sessions.saveUpload(s, { name, mime, bytes });
      return c.json({ id: row.id, name: row.name, mime: row.mime, size: row.size }, 201);
    },
  );

  // An upload's bytes, e.g. an image's thumbnail. Only images and PDFs show in place; anything else downloads.
  app.get('/api/sessions/:id/uploads/:upload', async (c) => {
    const s = sessions.get(c.req.param('id'));
    const row = s && sessions.uploads(s, [c.req.param('upload')])[0];
    if (!row) return c.json({ error: 'no such upload' }, 404);
    const bytes = await readFile(row.path).catch(() => undefined);
    if (!bytes) return c.json({ error: 'the file is gone' }, 404);
    const show = inline(row.mime);
    return c.body(bytes, 200, {
      'content-type': show ? row.mime : 'application/octet-stream',
      'content-disposition': `${show ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      // Uploads never change.
      'cache-control': 'private, max-age=31536000, immutable',
    });
  });

  app.post('/api/sessions/:id/messages', async (c) => {
    const s = sessions.get(c.req.param('id'));
    if (!s) return c.json({ error: 'no such session' }, 404);
    const body = await jsonBody<{ text?: unknown; attachments?: unknown }>(c);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const ids = body.attachments ?? [];
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || !ids.every((id) => typeof id === 'string')) {
      return c.json({ error: `attachments must be at most ${MAX_ATTACHMENTS} upload ids` }, 400);
    }
    const files = sessions.uploads(s, [...new Set(ids)]);
    if (files.length !== new Set(ids).size) return c.json({ error: 'unknown upload in attachments' }, 400);
    if (!text && !files.length) return c.json({ error: 'text is required' }, 400);
    try {
      await s.send(text, 'user', files.length ? { attachments: files.map(({ id, name, mime, size, path }) => ({ id, name, mime, size, path })) } : {});
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
    return c.json(s.info(), 202);
  });

  app.post('/api/sessions/:id/interrupt', async (c) => {
    const s = sessions.get(c.req.param('id'));
    if (!s) return c.json({ error: 'no such session' }, 404);
    await s.interrupt();
    return c.json(s.info(), 202);
  });

  // KEF stream: each `kef` event carries its session-log index as the SSE id,
  // so a reconnect with Last-Event-ID resumes without gaps or repeats.
  app.get('/api/sessions/:id/events', (c) => {
    const s = sessions.get(c.req.param('id'));
    if (!s) return c.json({ error: 'no such session' }, 404);
    const lastId = Number(c.req.header('last-event-id') ?? c.req.query('after') ?? -1);
    // If the round-up is deleted, end the stream: the client's reconnect then finds it gone.
    return sse(c, (send, end) =>
      s.subscribe((u) => send({ event: 'kef', id: String(u.index), data: JSON.stringify(u.event) }), Number.isFinite(lastId) ? lastId + 1 : 0, end),
    );
  });

  // ── changes and review ──────────────────────────────────────────────
  // What changed (a round-up's feature branch, or one agent's work) and the person's review of it.
  // `/api/events` sends `changes` when a diff may have moved on, and `review` with the whole state.

  /** The round-up a review route is about (an agent's id is taken as its round-up's). */
  const roundUpOf = (c: Context) => {
    const s = orch && sessions.get(c.req.param('id') ?? '');
    return s ? s.roundUpId : undefined;
  };
  const roundOf = (c: Context): number | undefined | null => {
    const r = c.req.query('round');
    if (r === undefined || r === '') return undefined;
    return /^[1-9]\d{0,5}$/.test(r) ? Number(r) : null;
  };

  app.get('/api/sessions/:id/changes', async (c) => {
    if (!orch || !sessions.get(c.req.param('id'))) return c.json({ error: 'no such session' }, 404);
    const round = roundOf(c);
    if (round === null) return c.json({ error: 'round must be a round number' }, 400);
    try {
      const changes = await orch.changes.of(c.req.param('id'), { patches: c.req.query('patches') !== '0', ...(round ? { round } : {}) });
      return changes ? c.json(changes) : c.json({ error: 'no such session' }, 404);
    } catch (err) {
      return reviewError(c, err);
    }
  });

  app.get('/api/sessions/:id/changes/file', async (c) => {
    if (!orch || !sessions.get(c.req.param('id'))) return c.json({ error: 'no such session' }, 404);
    const path = c.req.query('path');
    const round = roundOf(c);
    if (!path) return c.json({ error: 'path is required' }, 400);
    if (round === null) return c.json({ error: 'round must be a round number' }, 400);
    try {
      const file = await orch.changes.file(c.req.param('id'), path, round ?? undefined);
      return file ? c.json(file) : c.json({ error: file === null ? 'that file did not change' : 'no such session' }, 404);
    } catch (err) {
      return reviewError(c, err);
    }
  });

  app.get('/api/sessions/:id/review', async (c) => {
    const roundUp = roundUpOf(c);
    if (!roundUp || !orch) return c.json({ error: 'no such session' }, 404);
    return c.json(await orch.reviews.state(roundUp));
  });

  // A comment for the person's draft: a new thread ({ anchor, body }) or a reply ({ threadId, body }).
  app.post('/api/sessions/:id/review/comments', async (c) => {
    const roundUp = roundUpOf(c);
    if (!roundUp || !orch) return c.json({ error: 'no such session' }, 404);
    const body = await jsonBody<{ anchor?: unknown; threadId?: unknown; body?: unknown }>(c);
    try {
      if (typeof body.threadId === 'string') return c.json(await orch.reviews.comment(roundUp, { threadId: body.threadId, body: body.body as string }), 201);
      const anchor = anchorOf(body.anchor);
      if (!anchor) return c.json({ error: 'send { threadId, body } to reply, or { anchor: { view, viewSessionId?, path, side, line, commitSha, lineText }, body }' }, 400);
      return c.json(await orch.reviews.comment(roundUp, { anchor, body: body.body as string }), 201);
    } catch (err) {
      return reviewError(c, err);
    }
  });

  app.patch('/api/sessions/:id/review/comments/:commentId', async (c) => {
    const roundUp = roundUpOf(c);
    if (!roundUp || !orch) return c.json({ error: 'no such session' }, 404);
    const body = await jsonBody<{ body?: unknown }>(c);
    try {
      return c.json(orch.reviews.editComment(roundUp, c.req.param('commentId'), body.body));
    } catch (err) {
      return reviewError(c, err);
    }
  });

  app.delete('/api/sessions/:id/review/comments/:commentId', (c) => {
    const roundUp = roundUpOf(c);
    if (!roundUp || !orch) return c.json({ error: 'no such session' }, 404);
    try {
      orch.reviews.deleteComment(roundUp, c.req.param('commentId'));
      return c.body(null, 204);
    } catch (err) {
      return reviewError(c, err);
    }
  });

  app.delete('/api/sessions/:id/review/pending', (c) => {
    const roundUp = roundUpOf(c);
    if (!roundUp || !orch) return c.json({ error: 'no such session' }, 404);
    orch.reviews.discard(roundUp);
    return c.body(null, 204);
  });

  // Submits the draft: { verdict: comment | request_changes | approve, body? }. The orchestrator is told at once.
  app.post('/api/sessions/:id/review/submit', async (c) => {
    const roundUp = roundUpOf(c);
    if (!roundUp || !orch) return c.json({ error: 'no such session' }, 404);
    const body = await jsonBody<{ verdict?: unknown; body?: unknown }>(c);
    if (!VERDICTS.includes(body.verdict as (typeof VERDICTS)[number])) return c.json({ error: `verdict must be one of: ${VERDICTS.join(', ')}` }, 400);
    if (body.body !== undefined && typeof body.body !== 'string') return c.json({ error: 'body must be text' }, 400);
    try {
      return c.json(await orch.reviews.submit(roundUp, body.verdict as (typeof VERDICTS)[number], (body.body as string | undefined) ?? ''));
    } catch (err) {
      return reviewError(c, err);
    }
  });

  app.post('/api/sessions/:id/review/threads/:threadId/resolve', async (c) => {
    const roundUp = roundUpOf(c);
    if (!roundUp || !orch) return c.json({ error: 'no such session' }, 404);
    const body = await jsonBody<{ resolved?: unknown }>(c);
    if (typeof body.resolved !== 'boolean') return c.json({ error: 'resolved must be true or false' }, 400);
    try {
      return c.json(await orch.reviews.resolveByPerson(roundUp, c.req.param('threadId'), body.resolved));
    } catch (err) {
      return reviewError(c, err);
    }
  });

  // Keep unknown API paths out of the SPA fallback below.
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  if (opts.staticDir && existsSync(opts.staticDir)) {
    // serveStatic resolves `root` against the process cwd.
    const root = relative(process.cwd(), opts.staticDir) || '.';
    app.use('/*', serveStatic({ root }));
    app.get('*', serveStatic({ root, path: 'index.html' }));
  }

  return app;
}
