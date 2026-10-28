/**
 * What the composer suggests as the person types: `/` slash commands the session's harness runs
 * when sent as a turn, and `@` mentions of the repo's files.
 *
 * `GET /api/suggestions/commands?session=` answers with `SlashCommands`; `GET
 * /api/suggestions/files?session=&q=&limit=` with `FileMatches`. Without a session, both are for
 * Kelpie's own repo (a round-up not started yet).
 */

/** Where a command comes from: the CLI itself, the person's own setup (theirs, plugins, synced skills), or the repo. */
export type SlashCommandSource = 'built-in' | 'user' | 'project';

export interface SlashCommand {
  /** Without the slash: `compact`, `frontend:component`. */
  name: string;
  description: string;
  /** What it takes after the name, e.g. `[pr#]`; '' for nothing. */
  argumentHint: string;
  /** Other names it answers to, for matching. */
  aliases: string[];
  source: SlashCommandSource;
}

export interface SlashCommands {
  commands: SlashCommand[];
}

export interface FileMatches {
  /** Repo-relative paths, best match first. */
  files: string[];
  /** How many files the repo has in all (tracked, and new ones not ignored). */
  total: number;
}
