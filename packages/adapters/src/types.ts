import type { Answers, Effort, Harness, KelpieEvent, Mode, TodoItem } from '@kelpie/protocol';
import type { UsageLimitStop } from './limits.js';

export interface RunSpec {
  cwd: string;
  /** First user turn. Omit to start idle and call `send()` later. */
  prompt?: string;
  /** Defaults to a random UUID. */
  runId?: string;
  model?: string;
  /** Reasoning effort; the harness's default (its settings, then the model's) without it. */
  effort?: Effort;
  /** Harness session id to continue. */
  resume?: string;
  /** With `resume` only: the session's todo list as last seen, so the harness's updates to it are not lost. The adapter seeds from it as given. */
  todos?: TodoItem[];
  /** Defaults to 'acceptEdits'. */
  permissionMode?: string;
  /** Exact tool set; defaults to the adapter's standard set. */
  tools?: string[];
  /** Tools that run without a permission prompt (e.g. 'Bash', 'Bash(git:*)'). */
  allowedTools?: string[];
  disallowedTools?: string[];
  /**
   * Tools (rules) asked about every time, whatever the permission mode and any allow rule say: in
   * auto mode the CLI would otherwise decide MCP tool calls itself, without asking us.
   */
  askTools?: string[];
  /** Directories outside `cwd` the harness may work in too (e.g. the round-up's scratch folder). */
  addDirs?: string[];
  appendSystemPrompt?: string;
  /** MCP config files or JSON strings. Only these servers load (the user's global ones do not). */
  mcpConfig?: string[];
  /**
   * Drive the person's own browser (Claude Code's Claude in Chrome tools). Off unless asked for,
   * even if the person has it on by default for their own sessions.
   */
  browser?: boolean;
  /**
   * Where the private files a run needs while it lives go (its MCP configs, which can hold
   * secrets); default the OS temp directory. A spawner that owns this directory can sweep what a
   * crash left there.
   */
  tempDir?: string;
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
   * Answers a permission request the harness made (`permission.requested`); false if it is no longer
   * open (answered already, or the turn moved on). `rules` are permission rules to allow from now on
   * in this process (e.g. what the person chose to allow for the round-up).
   */
  answer(requestId: string, answer: PermissionAnswer): boolean;
  /** Switches the live process to a permission mode (a harness value, e.g. `acceptEdits`); false if it refused or never answered. */
  setMode(mode: string): Promise<boolean>;
  /** Switches the live process to a reasoning effort, from its next request on; false if it refused or never answered. */
  setEffort(effort: Effort): Promise<boolean>;
  /**
   * Stops the current turn; the session stays alive for further `send()`s.
   * Only if the harness does not answer at all is the process killed.
   */
  interrupt(): Promise<void>;
  /** Ends the session and the process. */
  stop(): Promise<RunExit>;
  readonly done: Promise<RunExit>;
}

export type PermissionAnswer =
  /** `answers`: for questions put to the person (`permission.requested` with `questions`), what they chose. */
  | { allow: true; by: 'person' | 'kelpie'; rules?: string[]; answers?: Answers }
  | { allow: false; by: 'person' | 'kelpie'; message: string };

export interface Adapter {
  readonly harness: Harness;
  /** The Kelpie modes this harness supports, in the order a person cycles through them. */
  readonly modes: readonly Mode[];
  start(spec: RunSpec): Run;
  /**
   * Whether an event ends a turn at the person's usage limit, and when that resets if known.
   * Kelpie pauses such a session and resumes it after the reset; harnesses without it never pause.
   */
  limitOf?(event: KelpieEvent, now?: Date): UsageLimitStop | undefined;
}
