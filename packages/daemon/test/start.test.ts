import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PortInUseError, startDaemon } from '../src/index.js';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** A port nothing is listening on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

describe('startDaemon', () => {
  it('serves the API and the UI on one port, and lets go of the data directory on close', async () => {
    const web = tmp('kelpie-web-');
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>kelpie</title>');
    const home = tmp('kelpie-home-');
    const cwd = tmp('kelpie-cwd-');
    mkdirSync(join(cwd, 'sub'));
    const port = await freePort();
    const daemon = await startDaemon({ cwd, port, home, staticDir: web });
    try {
      expect(daemon.url).toBe(`http://127.0.0.1:${port}`);
      const health = (await (await fetch(`${daemon.url}/api/health`)).json()) as { ok: boolean; defaultCwd: string };
      expect(health).toMatchObject({ ok: true, defaultCwd: cwd });
      // The UI, including client-side routes, from the same port.
      expect(await (await fetch(`${daemon.url}/`)).text()).toContain('<title>kelpie</title>');
      expect(await (await fetch(`${daemon.url}/r/some-round-up`)).text()).toContain('<title>kelpie</title>');

      // A second daemon (another data directory) can't take the port, and says so.
      await expect(startDaemon({ cwd, port, home: tmp('kelpie-home-') })).rejects.toThrow(PortInUseError);
    } finally {
      await daemon.close();
    }
    // Closed: the port and the data directory are free for the next start.
    const again = await startDaemon({ cwd, port, home });
    await again.close();
  });
});
