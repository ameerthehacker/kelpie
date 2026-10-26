import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const made: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const main = join(import.meta.dirname, '../src/main.ts');
const root = join(import.meta.dirname, '../../..');

/** A port nothing is listening on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/** Starts the dev entry point and returns the data directory it reports, then stops it. */
async function dataDir(env: Record<string, string | undefined>): Promise<string> {
  const { KELPIE_HOME: _, ...rest } = process.env;
  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=kelpie-src', main], {
    cwd: root,
    env: { ...rest, KELPIE_CWD: tmp('kelpie-cwd-'), KELPIE_PORT: String(await freePort()), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stderr.on('data', (d: Buffer) => (err += d));
  try {
    return await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (d: Buffer) => {
        out += d;
        const m = /· data (.+)\n/.exec(out);
        if (m) resolve(m[1]!);
      });
      child.once('exit', (code) => reject(new Error(`main.ts exited (${code}): ${err}`)));
    });
  } finally {
    // Already gone if it failed to start: its exit event has fired, and won't again.
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((ok) => child.once('exit', ok));
      child.kill('SIGTERM');
      await exited;
    }
  }
}

describe('dev daemon entry point', () => {
  it('keeps its data in ~/.kelpie-dev, apart from an installed Kelpie', async () => {
    const home = tmp('kelpie-user-');
    expect(await dataDir({ HOME: home })).toBe(join(home, '.kelpie-dev'));
  }, 30_000);

  it('uses KELPIE_HOME when it is set', async () => {
    const data = tmp('kelpie-home-');
    expect(await dataDir({ HOME: tmp('kelpie-user-'), KELPIE_HOME: data })).toBe(data);
  }, 30_000);
});
