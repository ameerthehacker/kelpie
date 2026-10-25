#!/usr/bin/env node
/**
 * `kelpie`: starts Kelpie (the daemon, its API and the web UI) on one loopback port, in the repo it
 * is run from, and opens the UI. Agents run on the person's own Claude Code.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import open from 'open';
import { limitsFromEnv, PortInUseError, startDaemon } from '@kelpie/daemon';

const MIN_NODE = 22;
const DEFAULT_PORT = 3173;
/** dist/ in the package (or src/ when run from source): the UI and migrations sit beside the bundle. */
const here = import.meta.dirname;
const { version } = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as { version: string };

function fail(message: string): never {
  console.error(`kelpie: ${message}`);
  process.exit(1);
}

function port(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new InvalidArgumentError('a port is a whole number from 1 to 65535');
  return n;
}

/** Kelpie drives the person's own Claude Code; without it nothing can run. */
function checkClaude(): void {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 20_000 });
  } catch {
    fail(
      'Kelpie runs your agents on Claude Code, but the `claude` command was not found.\n' +
        '  Install Claude Code (https://claude.com/claude-code), run `claude` once to log in, then start Kelpie again.',
    );
  }
}

const program = new Command()
  .name('kelpie')
  .description('Hand Kelpie many coding jobs at once: it plans them, runs them on your Claude Code, and brings the work together.')
  .version(version, '-v, --version')
  .addOption(new Option('-p, --port <port>', 'port for the UI and API').argParser(port).env('KELPIE_PORT').default(DEFAULT_PORT))
  .addOption(new Option('-C, --cwd <dir>', 'the repo agents work in').default(process.cwd(), 'the current directory'))
  .addOption(new Option('--home <dir>', "Kelpie's data directory: round-ups, logs, worktrees (default: ~/.kelpie)").env('KELPIE_HOME'))
  .addOption(new Option('--model <model>', "model for new round-ups, e.g. opus or sonnet (default: Claude Code's)").env('KELPIE_MODEL'))
  .option('--no-open', "don't open the UI in a browser")
  .action(async (opts: { port: number; cwd: string; home?: string; model?: string; open: boolean }) => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < MIN_NODE) fail(`Kelpie needs Node ${MIN_NODE} or newer; this is ${process.versions.node}.`);
    const cwd = resolve(opts.cwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) fail(`not a directory: ${cwd}`);
    checkClaude();

    const daemon = await startDaemon({
      cwd,
      port: opts.port,
      ...(opts.home ? { home: opts.home } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      staticDir: join(here, 'web'),
      migrationsFolder: join(here, 'drizzle'),
      ...limitsFromEnv(),
    }).catch((err: Error) => fail(err instanceof PortInUseError ? `${err.message}; choose another with --port` : err.message));

    console.log(`Kelpie ${version} on ${daemon.url}\n  repo  ${cwd}\n  data  ${daemon.home}\nPress Ctrl-C to stop; work under way picks up again next time.`);
    if (opts.open) open(daemon.url).catch(() => console.log(`Open ${daemon.url} in your browser.`));

    let stopping = false;
    const stop = async () => {
      if (stopping) process.exit(1);
      stopping = true;
      console.log('\nStopping Kelpie… (Ctrl-C again to force)');
      await daemon.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

await program.parseAsync();
