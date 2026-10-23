import { existsSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SessionManager, SessionUpdate } from './sessions.js';

export interface AppOptions {
  /** Built web UI to serve at `/`. */
  staticDir?: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const hostnameOf = (hostHeader: string) => hostHeader.replace(/:\d+$/, '');

/**
 * Sessions run a coding agent that can execute shell commands, so only local
 * pages may drive it: the Host must be a loopback name (defeats DNS
 * rebinding), any Origin must be local (defeats cross-site requests), and
 * writes must be JSON (forces a CORS preflight, which we never grant).
 */
export const localOnly: MiddlewareHandler = async (c, next) => {
  if (!LOCAL_HOSTS.has(hostnameOf(c.req.header('host') ?? ''))) return c.text('forbidden host', 403);
  const origin = c.req.header('origin');
  if (origin) {
    let ok = false;
    try {
      ok = LOCAL_HOSTS.has(new URL(origin).hostname);
    } catch {}
    if (!ok) return c.text('forbidden origin', 403);
  }
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !c.req.header('content-type')?.startsWith('application/json')) {
    return c.text('expected application/json', 415);
  }
  await next();
};

export function createApp(sessions: SessionManager, opts: AppOptions = {}): Hono {
  const app = new Hono();
  app.use('/api/*', localOnly);

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/sessions', (c) => c.json(sessions.list()));

  app.post('/api/sessions', async (c) => {
    const body = await c.req.json<{ cwd?: string }>().catch(() => ({}) as { cwd?: string });
    const cwd = body.cwd ?? sessions.defaultCwd;
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return c.json({ error: `not a directory: ${cwd}` }, 400);
    return c.json(sessions.create(cwd).info(), 201);
  });

  app.get('/api/sessions/:id', (c) => {
    const s = sessions.get(c.req.param('id'));
    return s ? c.json(s.info()) : c.json({ error: 'no such session' }, 404);
  });

  app.post('/api/sessions/:id/messages', async (c) => {
    const s = sessions.get(c.req.param('id'));
    if (!s) return c.json({ error: 'no such session' }, 404);
    const body = await c.req.json<{ text?: unknown }>().catch(() => ({}) as { text?: unknown });
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return c.json({ error: 'text is required' }, 400);
    try {
      s.send(text);
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
    return streamSSE(c, async (stream) => {
      let chain = Promise.resolve();
      const write = (u: SessionUpdate) => {
        chain = chain.then(() => stream.writeSSE({ event: 'kef', id: String(u.index), data: JSON.stringify(u.event) }));
      };
      const unsubscribe = s.subscribe(write, Number.isFinite(lastId) ? lastId + 1 : 0);
      let open = true;
      stream.onAbort(() => {
        open = false;
        unsubscribe();
      });
      while (open) {
        await stream.sleep(15_000);
        if (open) chain = chain.then(() => stream.writeSSE({ event: 'ping', data: '' }));
      }
    });
  });

  if (opts.staticDir && existsSync(opts.staticDir)) {
    // serveStatic resolves `root` against the process cwd.
    const root = relative(process.cwd(), opts.staticDir) || '.';
    app.use('/*', serveStatic({ root }));
    app.get('*', serveStatic({ root, path: 'index.html' }));
  }

  return app;
}
