/**
 * Kelpie daemon: serves the chat API and, when built, the web UI.
 *
 *   pnpm kelpie:serve [--cwd <repo>] [--port 7317] [--model m]
 *
 * KELPIE_CWD / KELPIE_PORT / KELPIE_MODEL set the same defaults; `pnpm dev` runs it through turbo,
 * whose working directory is this package, so it passes the repo via KELPIE_CWD.
 * Round-ups and run logs live under KELPIE_HOME (default ~/.kelpie).
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { openStore } from '@kelpie/store';
import lockfile from 'proper-lockfile';
import { createApp } from './server.js';
import { SessionManager } from './sessions.js';

const { values: opts } = parseArgs({
  options: {
    cwd: { type: 'string', default: process.env.KELPIE_CWD || process.cwd() },
    port: { type: 'string', default: process.env.KELPIE_PORT || '7317' },
    model: { type: 'string', ...(process.env.KELPIE_MODEL ? { default: process.env.KELPIE_MODEL } : {}) },
  },
});

const home = resolve(process.env.KELPIE_HOME || join(homedir(), '.kelpie'));
mkdirSync(home, { recursive: true });

// One daemon per KELPIE_HOME: a second one would "repair" runs the first is still finishing.
// A daemon restarting (tsx watch, a quick stop/start) waits here for its predecessor to let go;
// a lock left by a killed daemon goes stale after a few seconds.
const unlock = await lockfile
  .lock(home, {
    lockfilePath: join(home, 'daemon.lock'),
    stale: 5_000,
    retries: { retries: 60, factor: 1, minTimeout: 250, maxTimeout: 250 },
    onCompromised: (err) => console.error('kelpie: lost the data directory lock', err),
  })
  .catch(() => {
    console.error(`kelpie: another daemon is using ${home}`);
    process.exit(1);
  });

const store = openStore(join(home, 'kelpie.db'));
const sessions = new SessionManager({
  store,
  defaultCwd: resolve(opts.cwd),
  runsDir: join(home, 'runs'),
  defaults: {
    ...(opts.model ? { model: opts.model } : {}),
    // Without a permission prompt in this UI yet, Bash would otherwise be denied outright.
    allowedTools: ['Bash'],
  },
});
const app = createApp(sessions, { staticDir: join(import.meta.dirname, '../../../apps/web/dist') });
const port = Number(opts.port);
// Loopback only: sessions can run shell commands.
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`kelpie daemon on http://127.0.0.1:${port} · default cwd ${sessions.defaultCwd} · data ${home}`);
});

let closing = false;
const shutdown = async () => {
  if (closing) process.exit(1);
  closing = true;
  // Let each run's closing events reach the store before it closes.
  await sessions.stopAll();
  store.close();
  await unlock();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
