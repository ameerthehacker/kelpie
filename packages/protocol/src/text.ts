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

const ATTACHMENTS = /\n*<attachments>\n[^]*?\n<\/attachments>\s*$/;

/** A file's size as people read it: `12 B`, `240 KB`, `3.1 MB`. */
export const fileSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The block a turn's files are listed in, by absolute path, for the harness to read with its own tools. */
export function attachmentsBlock(files: { path: string; mime?: string | undefined; size: number }[]): string {
  const lines = files.map((f) => `- ${f.path} (${f.mime || 'file'}, ${fileSize(f.size)})`);
  return `<attachments>\n${lines.join('\n')}\n</attachments>`;
}

/** A turn's text without its `<attachments>` block (the UI shows the files as chips instead). */
export function stripAttachments(text: string): string {
  return text.replace(ATTACHMENTS, '');
}

/** Characters that show as nothing, or as something else: controls, format ones (bidi, zero-width, BOM), line and paragraph separators. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const NAMED: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** Whether text has characters that would hide what it says (see `visible`). */
export const hasHidden = (text: string): boolean => new RegExp(HIDDEN.source, 'u').test(text);

/**
 * Text as it may be shown where what is shown must be what runs (a command line, a path): each
 * hidden character written out, `\n` or `\u{202e}`, so a bidi override or a zero-width space can't
 * make it read as something else.
 */
export const visible = (text: string): string => text.replace(HIDDEN, (c) => NAMED[c] ?? `\\u{${c.codePointAt(0)!.toString(16)}}`);
