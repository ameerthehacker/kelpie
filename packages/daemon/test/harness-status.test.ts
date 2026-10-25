import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '@kelpie/store';
import { claudeCodeStatus, createApp, parseVersion, SessionManager, type HarnessStatus } from '../src/index.js';

/** A directory holding a fake `claude` that runs `script` (sh), to serve as the whole PATH. */
function fakePath(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kelpie-bin-'));
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, 'claude'), 0o755);
  return dir;
}

const VERSION = `if [ "$1" = "--version" ]; then echo "2.1.308 (Claude Code)"; exit 0; fi`;
const status = (dir: string, extra: NodeJS.ProcessEnv = {}) => claudeCodeStatus({ env: { PATH: dir, ...extra } });

describe('claudeCodeStatus', () => {
  it('reports a missing CLI', async () => {
    const s = await status(mkdtempSync(join(tmpdir(), 'kelpie-empty-')));
    expect(s).toMatchObject({ harness: 'claude-code', installed: false, loggedIn: false });
    expect(s.path).toBeUndefined();
  });

  it('finds it on PATH, parses its version and asks it whether it is signed in', async () => {
    const dir = fakePath(`${VERSION}
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'; exit 0; fi
exit 2`);
    expect(await status(dir)).toMatchObject({ installed: true, path: join(dir, 'claude'), version: '2.1.308', loggedIn: true, authMethod: 'claude.ai' });
  });

  it('reads a signed-out answer, which exits 1', async () => {
    const dir = fakePath(`${VERSION}
echo '{"loggedIn":false,"authMethod":"none"}'; exit 1`);
    const s = await status(dir);
    expect(s).toMatchObject({ installed: true, version: '2.1.308', loggedIn: false });
    expect(s.authMethod).toBeUndefined();
  });

  it("falls back to sign-in env vars when the CLI has no auth check, and otherwise can't tell", async () => {
    const dir = fakePath(`${VERSION}
echo "error: unknown command 'auth'" >&2; exit 1`);
    expect(await status(dir)).toMatchObject({ installed: true, version: '2.1.308', loggedIn: null });
    expect(await status(dir, { ANTHROPIC_API_KEY: 'sk-test' })).toMatchObject({ loggedIn: true, authMethod: 'api_key' });
  });

  it('reports a CLI that is there but broken', async () => {
    const dir = fakePath(`echo "Error: bad install" >&2; exit 3`);
    expect(await status(dir)).toMatchObject({ installed: true, loggedIn: null, error: 'Error: bad install' });
  });

  it('parses versions', () => {
    expect(parseVersion('2.1.308 (Claude Code)')).toBe('2.1.308');
    expect(parseVersion('claude 3.0.0-beta.2\n')).toBe('3.0.0-beta.2');
    expect(parseVersion('nonsense')).toBeUndefined();
  });
});

describe('GET /api/harnesses/status', () => {
  const sessions = new SessionManager({ store: openStore(':memory:'), defaultCwd: tmpdir() });
  const ready: HarnessStatus = { harness: 'claude-code', installed: true, path: '/bin/claude', version: '2.1.308', loggedIn: true, checkedAt: 'now' };

  it('checks afresh every time, and shares a check already running', async () => {
    let checks = 0;
    let release!: () => void;
    const app = createApp(sessions, {
      checkHarnesses: async () => {
        checks++;
        await new Promise<void>((r) => (release = r));
        return [{ ...ready, checkedAt: String(checks) }];
      },
    });
    const get = () => app.request('/api/harnesses/status', { headers: { host: '127.0.0.1:7317' } });

    const [a, b] = [get(), get()];
    await new Promise((r) => setTimeout(r, 10));
    release();
    const first = await a;
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(await first.json()).toEqual([{ ...ready, checkedAt: '1' }]);
    expect(await (await b).json()).toEqual([{ ...ready, checkedAt: '1' }]);

    const c = get();
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await (await c).json()).toEqual([{ ...ready, checkedAt: '2' }]);
    expect(checks).toBe(2);
  });
});
