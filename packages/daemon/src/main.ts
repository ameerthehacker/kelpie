/**
 * Kelpie daemon for development: serves the chat API and, when built, the web UI.
 *
 *   pnpm kelpie:serve [--cwd <repo>] [--port 7317] [--model m]
 *
 * KELPIE_CWD / KELPIE_PORT / KELPIE_MODEL set the same defaults, KELPIE_MAX_AGENTS how many sub-agents
 * one orchestrator may have working at once, KELPIE_MAX_WORKTREES how many git worktrees may be on
 * disk (default 20), KELPIE_WORKTREE_IDLE_DAYS how long an unused clean one stays (default 3), and
 * KELPIE_MAX_UPLOAD_MB the largest file one upload may be (default 25); `pnpm dev` runs it through turbo,
 * whose working directory is this package, so it passes the repo via KELPIE_CWD.
 * Round-ups, run logs and each round-up's scratch folder live under KELPIE_HOME (default ~/.kelpie).
 * The published CLI (apps/cli) starts the same daemon through `startDaemon`.
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { limitsFromEnv, startDaemon } from './start.js';

const { values: opts } = parseArgs({
  options: {
    cwd: { type: 'string', default: process.env.KELPIE_CWD || process.cwd() },
    port: { type: 'string', default: process.env.KELPIE_PORT || '7317' },
    model: { type: 'string', ...(process.env.KELPIE_MODEL ? { default: process.env.KELPIE_MODEL } : {}) },
  },
});

const daemon = await startDaemon({
  cwd: opts.cwd,
  port: Number(opts.port),
  ...(process.env.KELPIE_HOME ? { home: process.env.KELPIE_HOME } : {}),
  ...(opts.model ? { model: opts.model } : {}),
  staticDir: join(import.meta.dirname, '../../../apps/web/dist'),
  ...limitsFromEnv(),
}).catch((err: Error) => {
  console.error(`kelpie: ${err.message}`);
  process.exit(1);
});
console.log(`kelpie daemon on ${daemon.url} · default cwd ${opts.cwd} · data ${daemon.home}`);

let stopping = false;
const shutdown = async () => {
  if (stopping) process.exit(1);
  stopping = true;
  await daemon.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
