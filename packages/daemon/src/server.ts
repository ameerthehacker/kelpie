import { existsSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { streamSSE, type SSEMessage } from 'hono/streaming';
import { isLocalHost, isLocalOrigin } from './local.js';
import { handleMcp } from './orchestrator/mcp.js';
import type { Orchestrator } from './orchestrator/orchestrator.js';
import type { SessionManager } from './sessions.js';

export interface AppOptions {
  /** Built web UI to serve at `/`. */
  staticDir?: string;
  /** Serves the kelpie MCP server (the orchestrator's tools) at `/mcp`. */
  orchestrator?: Orchestrator;
}

/**
 * Only local pages may drive the API (see local.ts), and writes must be JSON (forces a
 * CORS preflight, which we never grant).
 */
export const localOnly: MiddlewareHandler = async (c, next) => {
  if (!isLocalHost(c.req.header('host'))) return c.text('forbidden host', 403);
  const origin = c.req.header('origin');
  if (origin && !isLocalOrigin(origin)) return c.text('forbidden origin', 403);
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !c.req.header('content-type')?.startsWith('application/json')) {
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

export function createApp(sessions: SessionManager, opts: AppOptions = {}): Hono {
  const app = new Hono();
  app.use('/api/*', localOnly);
  const orch = opts.orchestrator;
  if (orch) app.all('/mcp', (c) => handleMcp(c, orch));

  app.get('/api/health', (c) => c.json({ ok: true, defaultCwd: sessions.defaultCwd }));

  app.get('/api/sessions', (c) => c.json(sessions.list()));

  app.get('/api/usage', (c) => c.json(sessions.usage()));

  // Round-up list and harness usage: snapshots, then every change.
  app.get('/api/events', (c) =>
    sse(c, (send) => {
      send({ event: 'sessions', data: JSON.stringify(sessions.list()) });
      send({ event: 'usage', data: JSON.stringify(sessions.usage()) });
      return sessions.watch((u) => {
        if (u.type === 'session') send({ event: 'session', data: JSON.stringify(u.session) });
        else if (u.type === 'deleted') send({ event: 'deleted', data: JSON.stringify({ id: u.id }) });
        else if (u.type === 'agent') send({ event: 'agent', data: JSON.stringify(u.agent) });
        else send({ event: 'usage', data: JSON.stringify(u.usage) });
      });
    }),
  );

  app.post('/api/sessions', async (c) => {
    const body = await jsonBody<{ cwd?: unknown }>(c);
    if (body.cwd !== undefined && typeof body.cwd !== 'string') return c.json({ error: 'cwd must be a string' }, 400);
    // Relative to the daemon's default repo, not its process cwd (a package dir under `pnpm dev`).
    const cwd = resolve(sessions.defaultCwd, body.cwd ?? '.');
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return c.json({ error: `not a directory: ${cwd}` }, 400);
    return c.json(sessions.create(cwd).info(), 201);
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
    const body = await jsonBody<{ title?: unknown }>(c);
    const title = typeof body.title === 'string' ? body.title.trim().replace(/\s+/g, ' ') : '';
    if (!title || title.length > 200) return c.json({ error: 'title must be 1-200 characters' }, 400);
    s.rename(title);
    return c.json(s.info());
  });

  app.delete('/api/sessions/:id', async (c) => {
    return (await sessions.delete(c.req.param('id'))) ? c.body(null, 204) : c.json({ error: 'no such session' }, 404);
  });

  app.post('/api/sessions/:id/messages', async (c) => {
    const s = sessions.get(c.req.param('id'));
    if (!s) return c.json({ error: 'no such session' }, 404);
    const body = await jsonBody<{ text?: unknown }>(c);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return c.json({ error: 'text is required' }, 400);
    try {
      await s.send(text);
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
