import { mkdirSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { openStore } from '@kelpie/store';
import lockfile from 'proper-lockfile';
import { Connections } from './connectors/connector.js';
import { GitHubConnector } from './connectors/github.js';
import { canStart, checkHarnesses, shared, type HarnessStatus } from './harness-status.js';
import { McpServers } from './mcp-servers.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { createApp } from './server.js';
import { SessionManager } from './sessions.js';
import { Worktrees } from './worktrees.js';

const DAY = 24 * 60 * 60 * 1000;

export interface DaemonOptions {
  /** The repo round-ups work in unless they say otherwise. */
  cwd: string;
  port: number;
  /** Kelpie's data directory: the database, run logs, worktrees, scratch folders. Default ~/.kelpie. */
  home?: string;
  model?: string;
  /** Built web UI to serve at `/` on the same port. */
  staticDir?: string;
  /** Where the store's migrations are, when not beside its source (a bundled build). */
  migrationsFolder?: string;
  maxUploadBytes?: number;
  /** The agent limit until the person sets one in Settings (clamped to 1–16). */
  maxAgents?: number;
  maxWorktrees?: number;
  worktreeIdleMs?: number;
}

export interface Daemon {
  url: string;
  home: string;
  /** Checks each harness CLI's setup, sharing a check already running (the UI's own included). */
  checkHarnesses(): Promise<HarnessStatus[]>;
  /** Stops every harness (work under way resumes on the next start), closes the store, frees the port. */
  close(): Promise<void>;
}

/** Another daemon already holds this data directory. */
export class HomeInUseError extends Error {}

/** The port is taken. */
export class PortInUseError extends Error {}

/**
 * Starts Kelpie: the API, the kelpie MCP server and (with `staticDir`) the web UI, all on one
 * loopback port. Once listening, it brings the worktrees on disk back in line with the database and
 * resumes whatever was working when Kelpie last stopped (once a `claude` it can start is on PATH).
 */
export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const home = resolve(opts.home ?? join(homedir(), '.kelpie'));
  mkdirSync(home, { recursive: true });

  // One daemon per data directory: a second one would "repair" runs the first is still finishing.
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
      throw new HomeInUseError(`another Kelpie is already using ${home}`);
    });

  // Each harness's MCP configs (secrets among them) are in here while it runs; it removes its own
  // as it exits, so whatever is here now a crash or a kill left behind. No harness of this home is
  // running: it is ours (the lock).
  const tempDir = join(home, 'tmp');
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  // Where agents' stdio MCP servers start: empty, and only Kelpie writes here (see McpServers).
  const mcpCwd = join(home, 'mcp-cwd');
  rmSync(mcpCwd, { recursive: true, force: true });
  mkdirSync(mcpCwd, { recursive: true, mode: 0o700 });

  const store = openStore(join(home, 'kelpie.db'), opts.migrationsFolder ? { migrationsFolder: opts.migrationsFolder } : {});
  const worktrees = new Worktrees({
    store,
    root: join(home, 'worktrees'),
    ...(opts.worktreeIdleMs ? { idleMs: opts.worktreeIdleMs } : {}),
    ...(opts.maxWorktrees ? { max: opts.maxWorktrees } : {}),
  });
  const connections = new Connections([new GitHubConnector({ store })]);
  const mcpServers = new McpServers({ neutralDir: mcpCwd });
  const orchestrator = new Orchestrator({
    store,
    mcpUrl: `http://127.0.0.1:${opts.port}/mcp`,
    worktrees,
    connections,
    mcpServers,
    ...(opts.maxAgents ? { maxAgents: opts.maxAgents } : {}),
  });
  const sessions = new SessionManager({
    hooks: orchestrator,
    store,
    defaultCwd: resolve(opts.cwd),
    runsDir: join(home, 'runs'),
    scratchDir: join(home, 'scratch'),
    // What may run without asking is settled per session (the orchestrator's specFor, saved rules); anything else asks.
    defaults: { tempDir, ...(opts.model ? { model: opts.model } : {}) },
  });
  orchestrator.attach(sessions);

  // Resuming starts harnesses, and one that can't start dies before reading its turns, which drops
  // them. So while there is no `claude` on PATH, interrupted work waits: the first check that finds
  // one (the UI's Check again, or its setup dialog) resumes it, or else the next start does.
  let reconciled = false;
  let recovery: Promise<void> | undefined;
  const harnessStatus = shared(async () => {
    const statuses = await checkHarnesses();
    if (reconciled && !recovery && statuses.every(canStart)) recovery = orchestrator.recover().catch((err) => console.error('kelpie: recovery failed', err));
    return statuses;
  });
  const app = createApp(sessions, {
    orchestrator,
    checkHarnesses: harnessStatus,
    connections,
    mcpServers,
    ...(opts.staticDir ? { staticDir: opts.staticDir } : {}),
    ...(opts.maxUploadBytes ? { maxUploadBytes: opts.maxUploadBytes } : {}),
  });

  // Loopback only: sessions can run shell commands.
  const server = serve({ fetch: app.fetch, port: opts.port, hostname: '127.0.0.1' });
  try {
    await new Promise<void>((ok, fail) => {
      server.once('listening', ok);
      server.once('error', fail);
    });
  } catch (err) {
    // Nothing has started yet: let go of the data directory for the next attempt.
    store.close();
    await unlock();
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new PortInUseError(`port ${opts.port} is already in use`);
    throw err;
  }

  // Now the MCP server is up: make the worktrees on disk match the database, then resume whatever
  // was working when Kelpie last stopped.
  void orchestrator
    .reconcile()
    .catch((err) => console.error('kelpie: worktree reconcile failed', err))
    .then(() => {
      reconciled = true;
      return harnessStatus();
    })
    .then(() => recovery)
    .catch((err) => console.error('kelpie: harness check failed', err))
    .then(() => orchestrator.sweep())
    .catch((err) => console.error('kelpie: worktree sweep failed', err));
  // Worktrees left idle (and clean) for days come off disk; their branches stay.
  const sweep = setInterval(() => void orchestrator.sweep().catch((err) => console.error('kelpie: worktree sweep failed', err)), 60 * 60 * 1000);
  sweep.unref();

  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${opts.port}`,
    home,
    checkHarnesses: harnessStatus,
    close: () =>
      (closing ??= (async () => {
        clearInterval(sweep);
        // Whatever is still working resumes on the next start; let each run's closing events reach the store before it closes.
        sessions.prepareShutdown();
        await sessions.stopAll();
        store.close();
        await unlock();
        // Open event streams would otherwise hold the server open.
        // (`serve` makes a plain http.Server unless told otherwise.)
        (server as Server).closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      })()),
  };
}

/**
 * The limits people set through the environment: KELPIE_MAX_UPLOAD_MB, KELPIE_WORKTREE_IDLE_DAYS,
 * KELPIE_MAX_AGENTS and KELPIE_MAX_WORKTREES. Shared by every way of starting Kelpie.
 */
export function limitsFromEnv(): Pick<DaemonOptions, 'maxUploadBytes' | 'worktreeIdleMs' | 'maxAgents' | 'maxWorktrees'> {
  const uploadMb = envNumber('KELPIE_MAX_UPLOAD_MB');
  const idleDays = envNumber('KELPIE_WORKTREE_IDLE_DAYS');
  const maxAgents = envNumber('KELPIE_MAX_AGENTS');
  const maxWorktrees = envNumber('KELPIE_MAX_WORKTREES');
  return {
    ...(uploadMb ? { maxUploadBytes: uploadMb * 1024 * 1024 } : {}),
    ...(idleDays ? { worktreeIdleMs: idleDays * DAY } : {}),
    ...(maxAgents ? { maxAgents } : {}),
    ...(maxWorktrees ? { maxWorktrees } : {}),
  };
}

/**
 * A positive number from an environment variable, or undefined. A typo must not switch a limit off:
 * anything else is reported and the default kept.
 */
export function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (n > 0) return n;
  console.error(`kelpie: ${name} must be a positive number; using the default`);
  return undefined;
}
