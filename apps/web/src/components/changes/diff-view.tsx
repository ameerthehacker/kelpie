import { getSingularPatch } from '@pierre/diffs';
import { FileDiff, type DiffLineAnnotation, type FileDiffOptions } from '@pierre/diffs/react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { isStale, useReview } from '@/hooks/use-review';
import { gutterNumbers, splitPath, type ChangedFile } from '@/lib/changes';
import { anchorFor, annotationsFor, followDraft, lineTextAt, splitOutdated, type ReviewThread, type Side, type ThreadAnnotation } from '@/lib/review';
import { useTheme } from '@/lib/theme';
import { CommentBox, ThreadStrip, ThreadView } from './thread';
import type { DiffScope } from './scope';

type Meta = ThreadAnnotation['metadata'];

/** The comment being written: on which line, the line's text, and what is written so far. */
interface Draft {
  side: Side;
  line: number;
  text: string;
  body: string;
  /** Refused as stale: the box follows its line when the reloaded changes arrive. */
  stale?: boolean;
  note?: string;
  /** Bumped when the box is re-anchored, to start it afresh. */
  rev: number;
}

// The diff renders in its own shadow root: it is styled through its CSS variables, which cross it.
const DIFF_STYLE = {
  '--diffs-font-family': 'var(--font-mono)',
  '--diffs-header-font-family': 'var(--font-sans)',
  '--diffs-font-size': '12px',
  '--diffs-line-height': '20px',
  // The scrollbar's height is otherwise measured, and overlay scrollbars (macOS) measure 0: none to grab.
  '--diffs-scrollbar-gutter-override': '10px',
} as CSSProperties;

const THUMB = 'color-mix(in lab, var(--diffs-fg) 22%, var(--diffs-bg))';
const THUMB_HOVER = 'color-mix(in lab, var(--diffs-fg) 38%, var(--diffs-bg))';

/** What the diff's own CSS does not do as wanted; it is the shadow root's last layer. */
const DIFF_CSS = [
  // The card has the header. Not `disableFileHeader`: in @pierre/diffs 1.6 a re-render with it set
  // leaves the diff blank, so its header is hidden instead.
  '[data-diffs-header] { display: none; }',
  '[data-line-number-content] { white-space: pre; }',
  // Long lines scroll sideways under a scrollbar that shows, not one only there on hover.
  `[data-code]::-webkit-scrollbar-thumb { background-color: ${THUMB}; border-radius: 5px; border: 2px solid transparent; }`,
  `[data-code]::-webkit-scrollbar-thumb:hover { background-color: ${THUMB_HOVER}; }`,
  `@supports (-moz-appearance: none) { [data-code] { scrollbar-color: ${THUMB} transparent; } }`,
  // A hunk's header stays in view as the code scrolls (or wraps), cut short with an ellipsis; its
  // title has it whole. It sits right of its gutter cell (100%), so it gets the code's width (as
  // the diff's own `line-info` separators measure it) less that. A block, not the diff's flex: a
  // flex box's text gets no ellipsis.
  '[data-code] { container-type: inline-size; }',
  '[data-gutter] [data-separator=metadata] [data-separator-wrapper] { display: block; align-content: center; min-width: 0; max-width: calc(100cqi - 100%); }',
].join('\n');

/**
 * Old and new line numbers in two columns, as GitHub's unified diff has them: @pierre/diffs 1.6
 * gives a unified gutter one number per row, so each cell's is rewritten from the row it labels
 * (same `data-line-index`), which carries both.
 */
function numberBothSides(host: HTMLElement): void {
  const root = host.shadowRoot ?? host;
  const rows = new Map<string, { type: string | null; line: number; alt?: number }>();
  let widest = 1;
  for (const el of root.querySelectorAll<HTMLElement>('[data-line][data-line-index]')) {
    const line = Number(el.dataset.line);
    const alt = el.dataset.altLine ? Number(el.dataset.altLine) : undefined;
    rows.set(el.dataset.lineIndex!, { type: el.dataset.lineType ?? null, line, ...(alt !== undefined ? { alt } : {}) });
    widest = Math.max(widest, String(line).length, String(alt ?? '').length);
  }
  for (const cell of root.querySelectorAll<HTMLElement>('[data-column-number][data-line-index]')) {
    const row = rows.get(cell.dataset.lineIndex!);
    const label = cell.querySelector('[data-line-number-content]');
    if (row && label) label.textContent = gutterNumbers(row.type, row.line, row.alt, widest);
  }
}

/** A hunk's header is cut short when it is wider than the diff: hovering it shows it whole. */
function titleHunks(host: HTMLElement): void {
  const root = host.shadowRoot ?? host;
  for (const el of root.querySelectorAll<HTMLElement>('[data-separator=metadata] [data-separator-wrapper]')) el.title = el.textContent?.trim() ?? '';
}

/**
 * One file's diff (@pierre/diffs, loaded lazily), with the review on it: threads on their lines,
 * the rest in a strip above, and a comment box on the line clicked.
 */
export default function DiffView({ file, patch, threads, scope, wrap }: { file: ChangedFile; patch: string; threads: ReviewThread[]; scope: DiffScope; wrap?: boolean }) {
  const review = useReview(scope.roundUpId);
  const theme = useTheme();
  const parsed = useMemo(() => {
    try {
      return getSingularPatch(patch);
    } catch {
      return undefined;
    }
  }, [patch]);
  const [draft, setDraft] = useState<Draft | null>(null);
  // What is written in the open box; kept if the box has to close because its line is gone.
  const typed = useRef('');
  const [held, setHeld] = useState<string | null>(null);
  const split = useMemo(() => splitOutdated(threads, file, parsed?.hunks), [threads, file, parsed]);
  const annotations = useMemo(() => annotationsFor(split.inline, file.path, draft ?? undefined), [split.inline, file.path, draft]);
  const byId = useMemo(() => new Map(split.inline.map((t) => [t.id, t])), [split.inline]);

  // The diff keeps its options; what a click does reads the latest parse through a ref.
  const openAt = useRef<(side: Side, line: number) => void>(() => {});
  openAt.current = (side, line) => {
    const text = parsed && lineTextAt(parsed, side, line);
    if (text === undefined) return;
    typed.current = held ?? '';
    setDraft({ side, line, text, body: typed.current, rev: 0 });
    setHeld(null);
  };

  // The diff changed under the box (a 409 reloaded it, or a muster landed): the comment follows its
  // line, as GitHub's pending comments do, or closes with its text kept for the line picked next.
  const current = useRef(draft);
  current.current = draft;
  const shown = useRef(parsed);
  useEffect(() => {
    if (!parsed || shown.current === parsed) return;
    shown.current = parsed;
    const d = current.current;
    if (!d) return;
    const now = followDraft(d, parsed);
    if (!now) {
      setDraft(null);
      if (typed.current.trim()) setHeld(typed.current);
      return;
    }
    if (!now.moved && !d.stale) return;
    const note = now.moved ? `These changes moved on: your comment followed its line to line ${now.draft.line}. Check it, then add it again.` : 'These changes moved on: check the line, then add your comment again.';
    setDraft({ ...now.draft, body: typed.current, note, stale: false, rev: d.rev + 1 });
  }, [parsed]);
  const options = useMemo<FileDiffOptions<Meta, undefined>>(
    () => ({
      diffStyle: 'unified',
      unsafeCSS: DIFF_CSS,
      themeType: theme,
      hunkSeparators: 'metadata',
      diffIndicators: 'classic',
      // Scrolling, the line numbers stay put and the threads keep to the visible width.
      overflow: wrap ? 'wrap' : 'scroll',
      lineHoverHighlight: 'both',
      enableGutterUtility: true,
      // Context lines count as the new file's: they are anchored on `additions` by their new number.
      onLineClick: ({ annotationSide, lineNumber }) => openAt.current(annotationSide, lineNumber),
      onLineNumberClick: ({ annotationSide, lineNumber }) => openAt.current(annotationSide, lineNumber),
      onGutterUtilityClick: ({ start, side }) => openAt.current(side ?? 'additions', start),
      onPostRender: (host, _diff, phase) => {
        if (phase === 'unmount') return;
        numberBothSides(host);
        titleHunks(host);
      },
    }),
    [theme, wrap],
  );

  if (!parsed) return <p className="text-mu px-4 py-3 text-[13px]">Couldn't read this diff.</p>;
  const where = splitPath(file.path).dir.replace(/\/$/, '') || splitPath(file.path).base;

  const render = (a: DiffLineAnnotation<Meta>) => (
    <div className="flex flex-col gap-2 px-3 py-2 whitespace-normal">
      {a.metadata.threadIds.map((id) => {
        const t = byId.get(id);
        return t ? <ThreadView key={id} thread={t} roundUpId={scope.roundUpId} /> : null;
      })}
      {a.metadata.draft && draft && draft.note && <p className="text-mu text-xs">{draft.note}</p>}
      {a.metadata.draft && draft && (
        <CommentBox
          // A new key when the box is re-anchored: it starts again from what was written, without the old error.
          key={`${draft.side}:${draft.line}:${draft.rev}`}
          autoFocus
          initial={draft.body}
          placeholder={`Comment for ${where} on line ${draft.line}…`}
          onTextChange={(text) => (typed.current = text)}
          onCancel={() => setDraft(null)}
          onSubmit={async (body) => {
            try {
              await review.comment({
                anchor: anchorFor(scope, { path: file.path, side: draft.side, line: draft.line, lineText: draft.text }),
                body,
              });
            } catch (err) {
              // The changes are refetched (useReview); the box follows its line once they arrive.
              if (isStale(err)) {
                setDraft((d) => d && { ...d, stale: true });
                throw new Error('These changes moved on: reloading them…');
              }
              throw err;
            }
            setDraft(null);
          }}
        />
      )}
    </div>
  );

  return (
    <>
      <ThreadStrip threads={split.above} roundUpId={scope.roundUpId} />
      {held && (
        <p className="text-mu flex flex-wrap items-center gap-2 px-4 py-2 text-xs">
          These changes moved on and the line your comment was on is gone. Your comment is kept: click a line to place it.
          <button type="button" onClick={() => setHeld(null)} className="text-fg underline-offset-2 hover:underline">
            Discard it
          </button>
        </p>
      )}
      <FileDiff<Meta, undefined> fileDiff={parsed} options={options} lineAnnotations={annotations} renderAnnotation={render} style={DIFF_STYLE} />
    </>
  );
}
