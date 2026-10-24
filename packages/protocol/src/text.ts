/**
 * The first line of a message worth showing on one line: no headings, no markdown emphasis
 * or code ticks (identifiers like snake_case are left alone), whitespace collapsed, and cut
 * to `max` characters if given.
 */
export function firstLine(text: string, max?: number): string {
  const line = (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !/^#+\s/.test(l)) ?? ''
  )
    .replace(/(?<!\w)(\*\*|__|\*|_)(\S(?:.*?\S)?)\1(?!\w)/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ');
  return max !== undefined && line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
