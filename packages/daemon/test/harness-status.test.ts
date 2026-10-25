import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '@kelpie/store';
import { claudeCodeStatus, createApp, installDirs, parseVersion, SessionManager, type CheckOptions, type HarnessStatus } from '../src/index.js';

/** A directory holding a fake `claude` that runs `script` (sh), to serve as the whole PATH. */
function fakePath(script: string, dir = mkdtempSync(join(tmpdir(), 'kelpie-bin-'))): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, 'claude'), 0o755);
  return dir;
}

const VERSION = `if [ "$1" = "--version" ]; then echo "2.1.308 (Claude Code)"; exit 0; fi`;
const emptyDir = () => mkdtempSync(join(tmpdir(), 'kelpie-empty-'));
// No install locations by default: this machine's own `claude` mustn't turn up.
const status = (dir: string, extra: NodeJS.ProcessEnv = {}, opts: Omit<CheckOptions, 'env'> = {}) =>
  claudeCodeStatus({ env: { PATH: dir, ...extra }, installDirs: [], ...opts });

describe('claudeCodeStatus', () => {
  it('reports a missing CLI', async () => {
    expect(await status(emptyDir())).toEqual({ harness: 'claude-code', installed: false, loggedIn: false, platform: process.platform });
  });

  it('finds it on PATH, parses its version and asks it whether it is signed in', async () => {
    const dir = fakePath(`${VERSION}
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"me@example.com","orgName":"Acme"}'; exit 0; fi
exit 2`);
    // Exactly these fields: who is signed in (email, organization) stays out.
    expect(await status(dir)).toEqual({
      harness: 'claude-code',
      installed: true,
      path: join(dir, 'claude'),
      onPath: true,
      version: '2.1.308',
      loggedIn: true,
      authMethod: 'claude.ai',
      platform: process.platform,
    });
  });

  it('finds one installed off PATH, asks it all the same, and says it is off PATH', async () => {
    const home = emptyDir();
    const bin = fakePath(`${VERSION}
echo '{"loggedIn":true,"authMethod":"claude.ai"}'`, join(home, '.local', 'bin'));
    // The default install locations, with this HOME: the native installer's ~/.local/bin comes first.
    const s = await claudeCodeStatus({ env: { PATH: emptyDir(), HOME: home } });
    expect(s).toMatchObject({ installed: true, path: join(bin, 'claude'), onPath: false, version: '2.1.308', loggedIn: true });
    expect(installDirs({ HOME: home }, 'linux')[0]).toBe(join(home, '.local', 'bin'));
    // On PATH as well, it is just on PATH.
    expect(await claudeCodeStatus({ env: { PATH: bin, HOME: home } })).toMatchObject({ path: join(bin, 'claude'), onPath: true });
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
    expect(await status(dir, { CLAUDE_CODE_OAUTH_TOKEN: 'tok' })).toMatchObject({ loggedIn: true, authMethod: 'oauth_token' });
  });

  it("can't tell from an answer that isn't JSON, or has no loggedIn", async () => {
    const garbled = fakePath(`${VERSION}
echo '{"loggedIn":tru'`);
    const s = await status(garbled);
    expect(s).toMatchObject({ installed: true, version: '2.1.308', loggedIn: null });
    expect(s.error).toBeUndefined();
    expect(await status(fakePath(`${VERSION}
echo '{"authMethod":"claude.ai"}'`))).toMatchObject({ loggedIn: null });
    expect(await status(garbled, { CLAUDE_CODE_OAUTH_TOKEN: 'tok' })).toMatchObject({ loggedIn: true, authMethod: 'oauth_token' });
  });

  it('kills a CLI that hangs, and says so', async () => {
    const started = Date.now();
    const s = await status(fakePath(`${VERSION}
exec /bin/sleep 30`), {}, { timeoutMs: 2_000 });
    expect(s).toMatchObject({ installed: true, version: '2.1.308', loggedIn: null, error: '`claude auth status --json` didn\'t answer within 2s' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('gives up on something it started that holds its output open', async () => {
    // It answers and exits, but leaves a process holding stdout.
    const s = await status(fakePath(`echo "2.1.308 (Claude Code)"; /bin/sleep 30 & exit 0`), {}, { timeoutMs: 2_000 });
    expect(s).toMatchObject({ installed: true, version: '2.1.308' });
  });

  it('settles by its deadline whatever the CLI does, with what it found so far', async () => {
    const started = Date.now();
    const s = await status(fakePath(`exec /bin/sleep 4`), {}, { timeoutMs: 6_000, deadlineMs: 1_000 });
    expect(s).toMatchObject({ installed: true, onPath: true, loggedIn: null, error: "Claude Code didn't answer within 1s" });
    expect(Date.now() - started).toBeLessThan(3_000);
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
  const ready: HarnessStatus = { harness: 'claude-code', installed: true, path: '/bin/claude', onPath: true, version: '2.1.308', loggedIn: true, platform: 'linux' };

  it('checks afresh every time, and shares a check already running', async () => {
    let checks = 0;
    let release!: () => void;
    const app = createApp(sessions, {
      checkHarnesses: async () => {
        checks++;
        await new Promise<void>((r) => (release = r));
        return [{ ...ready, version: `${checks}.0.0` }];
      },
    });
    const get = () => app.request('/api/harnesses/status', { headers: { host: '127.0.0.1:7317' } });

    const [a, b] = [get(), get()];
    await new Promise((r) => setTimeout(r, 10));
    release();
    const first = await a;
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(await first.json()).toEqual([{ ...ready, version: '1.0.0' }]);
    expect(await (await b).json()).toEqual([{ ...ready, version: '1.0.0' }]);

    const c = get();
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await (await c).json()).toEqual([{ ...ready, version: '2.0.0' }]);
    expect(checks).toBe(2);
  });

  it('answers only loopback hosts', async () => {
    let checks = 0;
    const app = createApp(sessions, { checkHarnesses: async () => (checks++, [ready]) });
    expect((await app.request('/api/harnesses/status', { headers: { host: 'evil.example:7317' } })).status).toBe(403);
    expect((await app.request('/api/harnesses/status', { headers: { host: '127.0.0.1:7317', origin: 'https://evil.example' } })).status).toBe(403);
    expect(checks).toBe(0);
  });
});
