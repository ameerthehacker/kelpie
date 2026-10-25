import { describe, expect, it } from 'vitest';
import { authLabel, installCommands, needsSetup, setupSteps, type HarnessStatus } from '../src/lib/harness-setup.js';

const status = (s: Partial<HarnessStatus>): HarnessStatus => ({ harness: 'claude-code', installed: true, loggedIn: true, checkedAt: '', ...s });

describe('needsSetup', () => {
  it('asks for setup only when the CLI is missing or says it is signed out', () => {
    expect(needsSetup(undefined)).toBe(false);
    expect(needsSetup(status({ installed: false, loggedIn: false }))).toBe(true);
    expect(needsSetup(status({ loggedIn: false }))).toBe(true);
    expect(needsSetup(status({}))).toBe(false);
    // An older CLI that can't say gets the benefit of the doubt: no nagging.
    expect(needsSetup(status({ loggedIn: null }))).toBe(false);
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

  it('says what it found', () => {
    expect(setupSteps(status({ version: '2.1.308', authMethod: 'claude.ai' })).map((x) => x.detail)).toEqual(['Version 2.1.308', 'Claude account']);
    expect(setupSteps(status({ loggedIn: false, authMethod: 'none' }))[1]!.detail).toBeUndefined();
  });
});

describe('install commands', () => {
  it('offers the native installer for the platform, then npm', () => {
    expect(installCommands(false).map((c) => c.command)).toEqual(['curl -fsSL https://claude.ai/install.sh | bash', 'npm install -g @anthropic-ai/claude-code']);
    expect(installCommands(true)[0]!.command).toBe('irm https://claude.ai/install.ps1 | iex');
  });

  it('names sign-in methods in words, and keeps unknown ones as they are', () => {
    expect(authLabel('api_key')).toBe('API key');
    expect(authLabel('something_new')).toBe('something_new');
  });
});
