import { getSingularPatch } from '@pierre/diffs';
import { FileDiff, type DiffLineAnnotation, type FileDiffOptions } from '@pierre/diffs/react';
import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { isStale, useReview } from '@/hooks/use-review';
import { splitPath, type ChangedFile } from '@/lib/changes';
import { annotationsFor, lineTextAt, splitOutdated, type ReviewThread, type Side, type ThreadAnnotation } from '@/lib/review';
import { useTheme } from '@/lib/theme';
import { CommentBox, ThreadStrip, ThreadView } from './thread';
import type { DiffScope } from './scope';

type Meta = ThreadAnnotation['metadata'];

// The diff renders in its own shadow root: it is styled through its CSS variables, which cross it.
const DIFF_STYLE = {
  '--diffs-font-family': 'var(--font-mono)',
  '--diffs-header-font-family': 'var(--font-sans)',
  '--diffs-font-size': '12px',
  '--diffs-line-height': '20px',
} as CSSProperties;

/**
 * One file's diff (@pierre/diffs, loaded lazily), with the review on it: threads on their lines,
 * the rest in a strip above, and a comment box on the line clicked.
 */
export default function DiffView({ file, patch, threads, scope }: { file: ChangedFile; patch: string; threads: ReviewThread[]; scope: DiffScope }) {
  const review = useReview(scope.roundUpId);
  const theme = useTheme();
  const parsed = useMemo(() => {
    try {
      return getSingularPatch(patch);
    } catch {
      return undefined;
    }
  }, [patch]);
  const [draft, setDraft] = useState<{ side: Side; line: number; text: string } | null>(null);
  const split = useMemo(() => splitOutdated(threads, file, parsed?.hunks), [threads, file, parsed]);
  const annotations = useMemo(() => annotationsFor(split.inline, file.path, draft ?? undefined), [split.inline, file.path, draft]);
  const byId = useMemo(() => new Map(split.inline.map((t) => [t.id, t])), [split.inline]);

  // The diff keeps its options; what a click does reads the latest parse through a ref.
  const openAt = useRef<(side: Side, line: number) => void>(() => {});
  openAt.current = (side, line) => {
    const text = parsed && lineTextAt(parsed, side, line);
    if (text !== undefined) setDraft({ side, line, text });
  };
  const options = useMemo<FileDiffOptions<Meta, undefined>>(
    () => ({
      diffStyle: 'unified',
      // The card has the header. Not `disableFileHeader`: in @pierre/diffs 1.6 a re-render with it
      // set leaves the diff blank, so its header is hidden instead.
      unsafeCSS: '[data-diffs-header] { display: none; }',
      themeType: theme,
      hunkSeparators: 'metadata',
      diffIndicators: 'classic',
      overflow: 'scroll',
      lineHoverHighlight: 'both',
      enableGutterUtility: true,
      // Context lines count as the new file's: they are anchored on `additions` by their new number.
      onLineClick: ({ annotationSide, lineNumber }) => openAt.current(annotationSide, lineNumber),
      onLineNumberClick: ({ annotationSide, lineNumber }) => openAt.current(annotationSide, lineNumber),
      onGutterUtilityClick: ({ start, side }) => openAt.current(side ?? 'additions', start),
    }),
    [theme],
  );

  if (!parsed) return <p className="text-mu px-4 py-3 text-[13px]">Couldn't read this diff.</p>;
  const where = splitPath(file.path).dir.replace(/\/$/, '') || splitPath(file.path).base;

  const render = (a: DiffLineAnnotation<Meta>) => (
    <div className="flex flex-col gap-2 px-3 py-2 whitespace-normal">
      {a.metadata.threadIds.map((id) => {
        const t = byId.get(id);
        return t ? <ThreadView key={id} thread={t} roundUpId={scope.roundUpId} /> : null;
      })}
      {a.metadata.draft && draft && (
        <CommentBox
          autoFocus
          placeholder={`Comment for ${where} on line ${draft.line}…`}
          onCancel={() => setDraft(null)}
          onSubmit={async (body) => {
            try {
              await review.comment({
                anchor: {
                  view: scope.view,
                  ...(scope.viewSessionId ? { viewSessionId: scope.viewSessionId } : {}),
                  path: file.path,
                  side: draft.side,
                  line: draft.line,
                  commitSha: scope.commitSha ?? '',
                  lineText: draft.text,
                },
                body,
              });
            } catch (err) {
              if (isStale(err)) throw new Error('These changes moved on: they have been reloaded. Comment on the line as it is now.');
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
      <FileDiff<Meta, undefined> fileDiff={parsed} options={options} lineAnnotations={annotations} renderAnnotation={render} style={DIFF_STYLE} />
    </>
  );
}
