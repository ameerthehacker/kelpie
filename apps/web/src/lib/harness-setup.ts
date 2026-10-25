/** A harness CLI's setup, as `GET /api/harnesses/status` reports it (packages/daemon/src/harness-status.ts). */
export interface HarnessStatus {
  harness: string;
  installed: boolean;
  path?: string;
  version?: string;
  /** Null when the CLI couldn't say. */
  loggedIn: boolean | null;
  authMethod?: string;
  error?: string;
  checkedAt: string;
}

export const CLAUDE_CODE_DOCS = 'https://code.claude.com/docs/en/setup';

/** Claude Code's official installers: the native one for this platform, then npm, which works anywhere. */
export function installCommands(windows: boolean): { label: string; command: string }[] {
  return [
    windows
      ? { label: 'PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' }
      : { label: 'macOS, Linux, WSL', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
    { label: 'or with npm', command: 'npm install -g @anthropic-ai/claude-code' },
  ];
}

export const isWindows = () => typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent);

/**
 * Whether Kelpie can't run agents until the person does something: the CLI is missing, or it says it
 * is signed out. A CLI that couldn't say whether it is signed in gets the benefit of the doubt.
 */
export const needsSetup = (s: HarnessStatus | undefined) => !!s && (!s.installed || s.loggedIn === false);

export type StepState = 'done' | 'todo' | 'waiting' | 'unknown';

export interface SetupStep {
  id: 'install' | 'login';
  title: string;
  state: StepState;
  /** What the step found, when it is done. */
  detail?: string;
}

/** Install, then sign in: where the person is with each. Signing in waits on installing. */
export function setupSteps(s: HarnessStatus): SetupStep[] {
  return [
    {
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
