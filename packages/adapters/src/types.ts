import type { Harness, KelpieEvent } from '@kelpie/protocol';

export interface RunSpec {
  cwd: string;
  /** First user turn. Omit to start idle and call `send()` later. */
  prompt?: string;
  /** Defaults to a random UUID. */
  runId?: string;
  model?: string;
  /** Harness session id to continue. */
  resume?: string;
  /** Defaults to 'acceptEdits'. */
  permissionMode?: string;
  /** Exact tool set; defaults to the adapter's standard set. */
  tools?: string[];
  /** Tools that run without a permission prompt (e.g. 'Bash', 'Bash(git:*)'). */
  allowedTools?: string[];
  disallowedTools?: string[];
  appendSystemPrompt?: string;
  /** MCP config files or JSON strings. Only these servers load (the user's global ones do not). */
  mcpConfig?: string[];
  /** Where raw.jsonl and run.json go. Defaults to ~/.kelpie/runs/<runId>. */
  runDir?: string;
  /** Harness binary; defaults to the CLI on PATH. */
  bin?: string;
  env?: Record<string, string>;
  extraArgs?: string[];
}

export interface RunExit {
  code: number | null;
  signal: string | null;
}

export interface Run {
  readonly runId: string;
  readonly harness: Harness;
  readonly runDir: string;
  /** Normalized events. Single consumer; ends after `process.exited`. */
  readonly events: AsyncIterable<KelpieEvent>;
  /** Known once the harness has reported its session (after the first turn starts). */
  readonly harnessSessionId: string | undefined;
  /**
   * True while the harness is working or has sent turns still queued. Turns
   * are not 1:1 with `send()`s: queued messages can merge into the running
   * turn, and the harness can start a turn itself (a background sub-agent
   * finished).
   */
  readonly busy: boolean;
  readonly exited: boolean;
  /** Sends a user turn; if one is running, the harness queues it. Throws once the run is stopping or exited. */
  send(text: string): void;
  /**
   * Stops the current turn; the session stays alive for further `send()`s.
   * Only if the harness does not answer at all is the process killed.
   */
  interrupt(): Promise<void>;
  /** Ends the session and the process. */
  stop(): Promise<RunExit>;
  readonly done: Promise<RunExit>;
}

export interface Adapter {
  readonly harness: Harness;
  start(spec: RunSpec): Run;
}
