import type { HarnessStatus } from '@kelpie/protocol';

export type { HarnessStatus };

export const CLAUDE_CODE_DOCS = 'https://code.claude.com/docs/en/setup';

export interface Command {
  label: string;
  command: string;
}

/**
 * Claude Code's official installers: the native one for the daemon's platform (`process.platform`; the
 * browser's may differ, e.g. under WSL), then npm, which works anywhere.
 */
export function installCommands(platform: string): Command[] {
  return [
    platform === 'win32'
      ? { label: 'PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' }
      : { label: 'macOS, Linux, WSL', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
    { label: 'or with npm', command: 'npm install -g @anthropic-ai/claude-code' },
  ];
}

/** Installed, but somewhere the daemon's PATH doesn't reach (often the native installer's `~/.local/bin`). */
export const offPath = (s: HarnessStatus) => s.installed && s.onPath === false;

/** The directory the CLI was found in. */
export const binDir = (s: HarnessStatus) => s.path?.replace(/[\\/][^\\/]*$/, '') ?? '';

/** Lines that put the CLI's directory on PATH in new terminals. None on Windows, where it is a setting. */
export function pathCommands(s: HarnessStatus): Command[] {
  if (s.platform === 'win32') return [];
  const line = (rc: string) => `echo 'export PATH="${binDir(s)}:$PATH"' >> ${rc}`;
  const zsh = { label: 'zsh', command: line('~/.zshrc') };
  const bash = { label: 'bash', command: line('~/.bashrc') };
  // zsh is macOS's default shell, bash most Linux's.
  return s.platform === 'darwin' ? [zsh, bash] : [bash, zsh];
}

/**
 * Whether Kelpie can't run agents until the person does something: the CLI is missing or off PATH, or
 * it says it is signed out. A CLI that couldn't say whether it is signed in gets the benefit of the doubt.
 */
export const needsSetup = (s: HarnessStatus | undefined) => !!s && (!s.installed || offPath(s) || s.loggedIn === false);

/** All green: installed on PATH, signed in, and nothing went wrong checking. Anything less isn't "Ready". */
export const isReady = (s: HarnessStatus | undefined) => !!s && s.installed && !offPath(s) && s.loggedIn === true && !s.error;

export type StepState = 'done' | 'todo' | 'waiting' | 'unknown';

export interface SetupStep {
  id: 'install' | 'login';
  title: string;
  state: StepState;
  /** What the step found, when it is done. */
  detail?: string;
}

/**
 * Install, then sign in: where the person is with each. Signing in waits on installing. One installed
 * off PATH still has installing to finish: putting it on PATH.
 */
export function setupSteps(s: HarnessStatus): SetupStep[] {
  return [
    offPath(s)
      ? { id: 'install', title: 'Put Claude Code on PATH', state: 'todo', detail: s.version ? `Version ${s.version} found` : 'Found' }
      : {
          id: 'install',
          title: 'Install Claude Code',
          state: s.installed ? 'done' : 'todo',
          ...(s.installed ? { detail: s.version ? `Version ${s.version}` : 'Installed' } : {}),
        },
    {
      id: 'login',
      title: 'Sign in',
      state: !s.installed ? 'waiting' : s.loggedIn === null ? 'unknown' : s.loggedIn ? 'done' : 'todo',
      ...(s.loggedIn && s.authMethod ? { detail: authLabel(s.authMethod) } : {}),
    },
  ];
}

const AUTH: Record<string, string> = {
  'claude.ai': 'Claude account',
  api_key: 'API key',
  oauth_token: 'OAuth token',
  third_party: 'Cloud provider',
};

/** How the CLI is signed in, in words: `claude.ai` → "Claude account". */
export const authLabel = (method: string) => AUTH[method] ?? method;
