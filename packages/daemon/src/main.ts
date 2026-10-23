/**
 * Kelpie daemon: serves the chat API and, when built, the web UI.
 *
 *   pnpm kelpie:serve [--cwd <repo>] [--port 7317] [--model m]
 *
 * KELPIE_CWD / KELPIE_PORT / KELPIE_MODEL set the same defaults; `pnpm dev` runs it through turbo,
 * whose working directory is this package, so it passes the repo via KELPIE_CWD.
 */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { createApp } from './server.js';
import { SessionManager } from './sessions.js';

const { values: opts } = parseArgs({
  options: {
    cwd: { type: 'string', default: process.env.KELPIE_CWD || process.cwd() },
    port: { type: 'string', default: process.env.KELPIE_PORT || '7317' },
    model: { type: 'string', ...(process.env.KELPIE_MODEL ? { default: process.env.KELPIE_MODEL } : {}) },
  },
});

const sessions = new SessionManager(resolve(opts.cwd), {
  ...(opts.model ? { model: opts.model } : {}),
  // Without a permission prompt in this UI yet, Bash would otherwise be denied outright.
  allowedTools: ['Bash'],
});
const app = createApp(sessions, { staticDir: join(import.meta.dirname, '../../../apps/web/dist') });
const port = Number(opts.port);

// Loopback only: sessions can run shell commands.
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`kelpie daemon on http://127.0.0.1:${port} · default cwd ${sessions.defaultCwd}`);
});

let closing = false;
const shutdown = async () => {
  if (closing) process.exit(1);
  closing = true;
  await sessions.stopAll();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
