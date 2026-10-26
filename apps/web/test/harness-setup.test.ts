import { describe, expect, it } from 'vitest';
import { authLabel, installCommands, isReady, needsSetup, pathCommands, setupSteps, type HarnessStatus } from '../src/lib/harness-setup.js';

const status = (s: Partial<HarnessStatus>): HarnessStatus => ({ harness: 'claude-code', installed: true, onPath: true, loggedIn: true, platform: 'darwin', ...s });

describe('needsSetup', () => {
  it('asks for setup only when the CLI is missing or says it is signed out', () => {
    expect(needsSetup(undefined)).toBe(false);
    expect(needsSetup(status({ installed: false, loggedIn: false }))).toBe(true);
    expect(needsSetup(status({ loggedIn: false }))).toBe(true);
    expect(needsSetup(status({}))).toBe(false);
    // An older CLI that can't say gets the benefit of the doubt: no nagging.
    expect(needsSetup(status({ loggedIn: null }))).toBe(false);
    // Kelpie can't start one that isn't on its PATH.
    expect(needsSetup(status({ onPath: false }))).toBe(true);
  });
});

describe('isReady', () => {
  it('is green only when installed on PATH, signed in, and the check went fine', () => {
    expect(isReady(status({}))).toBe(true);
    expect(isReady(undefined)).toBe(false);
    expect(isReady(status({ installed: false, loggedIn: false }))).toBe(false);
    expect(isReady(status({ onPath: false }))).toBe(false);
    expect(isReady(status({ loggedIn: false }))).toBe(false);
    // Neither needs setup, but neither is "all set" either.
    expect(isReady(status({ loggedIn: null }))).toBe(false);
    expect(isReady(status({ error: '`claude auth status --json` didn’t answer within 10s' }))).toBe(false);
  });
});

describe('setupSteps', () => {
  const states = (s: HarnessStatus) => setupSteps(s).map((x) => x.state);

  it('installs first, and signing in waits for it', () => {
    expect(states(status({ installed: false, loggedIn: false }))).toEqual(['todo', 'waiting']);
    expect(states(status({ loggedIn: false }))).toEqual(['done', 'todo']);
    expect(states(status({ loggedIn: null }))).toEqual(['done', 'unknown']);
    expect(states(status({}))).toEqual(['done', 'done']);
  });

  it('asks for one found off PATH to be put on it', () => {
    const [install, login] = setupSteps(status({ onPath: false, version: '2.1.308' }));
    expect(install).toMatchObject({ title: 'Put Claude Code on PATH', state: 'todo', detail: 'Version 2.1.308 found' });
    expect(login!.state).toBe('done');
  });

  it('says what it found', () => {
    expect(setupSteps(status({ version: '2.1.308', authMethod: 'claude.ai' })).map((x) => x.detail)).toEqual(['Version 2.1.308', 'Claude account']);
    expect(setupSteps(status({ loggedIn: false, authMethod: 'none' }))[1]!.detail).toBeUndefined();
  });
});

describe('install commands', () => {
  it("offers the native installer for the daemon's platform, then npm", () => {
    expect(installCommands('darwin').map((c) => c.command)).toEqual(['curl -fsSL https://claude.ai/install.sh | bash', 'npm install -g @anthropic-ai/claude-code']);
    // A daemon in WSL is on Linux, whatever the browser runs on.
    expect(installCommands('linux')[0]!.command).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(installCommands('win32')[0]!.command).toBe('irm https://claude.ai/install.ps1 | iex');
  });

  it("puts the CLI's own directory on PATH, in the platform's usual shell first", () => {
    const at = (platform: string) => pathCommands(status({ onPath: false, path: '/home/me/.local/bin/claude', platform }));
    expect(at('linux').map((c) => c.command)).toEqual([
      `echo 'export PATH="/home/me/.local/bin:$PATH"' >> ~/.bashrc`,
      `echo 'export PATH="/home/me/.local/bin:$PATH"' >> ~/.zshrc`,
    ]);
    expect(at('darwin')[0]!.label).toBe('zsh');
    expect(at('win32')).toEqual([]);
  });

  it('names sign-in methods in words, and keeps unknown ones as they are', () => {
    expect(authLabel('api_key')).toBe('API key');
    expect(authLabel('something_new')).toBe('something_new');
  });
});
