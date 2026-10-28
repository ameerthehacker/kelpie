import fuzzysort from 'fuzzysort';
import type { SlashCommand } from '@kelpie/protocol';

/**
 * The composer's suggestions: `/` for a slash command, `@` to mention a file or an agent.
 *
 * A slash command runs only as the start of a message (the CLI takes a turn as a command only
 * then), so `/` opens the menu there alone, after any leading space. `@` opens it at the start of
 * a word anywhere. Either closes once the word under the caret ends (a space: a command's arguments).
 */
export interface Trigger {
  kind: '/' | '@';
  /** Where the `/` or `@` is. */
  start: number;
  /** What's typed after it, up to the caret. */
  query: string;
}

/** The trigger the caret is in, if any. */
export function triggerAt(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  const slash = /^\s*\/(\S*)$/.exec(before);
  if (slash) return { kind: '/', start: before.length - slash[1]!.length - 1, query: slash[1]! };
  // After a space or an opening bracket or quote, so an email address or `a@b` is left alone.
  const at = /(?:^|[\s([{"'`])@(\S*)$/.exec(before);
  if (at) return { kind: '@', start: before.length - at[1]!.length - 1, query: at[1]! };
  return undefined;
}

/**
 * The text with `insert` in place of the trigger's word (all of it, past the caret too), and a
 * space after it unless one is there already; and where the caret goes, after that space.
 */
export function applySuggestion(text: string, trigger: Trigger, insert: string): { text: string; caret: number } {
  const rest = text.slice(trigger.start);
  const end = trigger.start + (/^\S*/.exec(rest)?.[0].length ?? 0);
  const after = text.slice(end);
  const spaced = /^\s/.test(after) ? after : ` ${after}`;
  return { text: text.slice(0, trigger.start) + insert + spaced, caret: trigger.start + insert.length + 1 };
}

/** How a file is mentioned: `@path`, quoted if it has a space in it. */
export const fileMention = (path: string) => (/\s/.test(path) ? `@"${path}"` : `@${path}`);

/** How an agent is mentioned: by title, which is how the orchestrator and the Workbench know it. */
export const agentMention = (title: string) => `@${title}`;

/** The most of each kind the menu lists. */
export const MAX_SUGGESTIONS = 50;

/** Commands matching `query` (by name, or an alias), best first; all of them, in order, for none. */
export function rankCommands(commands: readonly SlashCommand[], query: string, limit = MAX_SUGGESTIONS): SlashCommand[] {
  if (!query) return commands.slice(0, limit);
  return fuzzysort.go(query, commands, { keys: ['name', (c) => c.aliases.join(' ')], limit }).map((r) => r.obj);
}

/** Things with a title (agents) matching `query`, best first. */
export function rankTitled<T extends { title: string }>(items: readonly T[], query: string, limit = MAX_SUGGESTIONS): T[] {
  if (!query) return items.slice(0, limit);
  return fuzzysort.go(query, items, { key: 'title', limit }).map((r) => r.obj);
}

/** Paths matching `query`, best first: for refining the last file matches while the daemon is asked about the newest query. */
export function rankPaths(paths: readonly string[], query: string, limit = MAX_SUGGESTIONS): string[] {
  if (!query) return paths.slice(0, limit);
  return fuzzysort.go(query, paths, { limit }).map((r) => r.target);
}
