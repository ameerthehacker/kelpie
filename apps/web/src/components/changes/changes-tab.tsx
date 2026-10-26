import { FolderIcon, GitBranchIcon, Maximize2Icon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useChanges } from '@/hooks/use-changes';
import { useChangesNav } from '@/hooks/use-changes-nav';
import { useDiffWrap } from '@/hooks/use-diff-wrap';
import { useReview } from '@/hooks/use-review';
import { anchorSha, filesLabel, musteredFromLabel, type ChangedFile } from '@/lib/changes';
import { threadsOffDiff, threadsOn, type ReviewThread } from '@/lib/review';
import { cn } from '@/lib/utils';
import { FileCard, FilePath, WrapToggle } from './file-card';
import { ReviewBar } from './review-bar';
import type { DiffScope } from './scope';
import { quietButton, ThreadView } from './thread';

/** The first files start open; the rest wait to be asked for. */
const OPEN_AT_FIRST = 30;

/** Which files are folded: the first few start open, and all of them fold or open together. */
export function useCollapsed(files: readonly ChangedFile[] | undefined, openAtFirst = OPEN_AT_FIRST) {
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const index = useMemo(() => new Map((files ?? []).map((f, i) => [f.path, i])), [files]);
  const isCollapsed = (path: string) => folded[path] ?? (index.get(path) ?? 0) >= openAtFirst;
  const anyOpen = (files ?? []).some((f) => !isCollapsed(f.path));
  return {
    isCollapsed,
    toggle: (path: string) => setFolded((s) => ({ ...s, [path]: !isCollapsed(path) })),
    anyOpen,
    setAll: (collapsed: boolean) => setFolded(Object.fromEntries((files ?? []).map((f) => [f.path, collapsed]))),
  };
}

/** `+185 −185`. */
export function Totals({ additions, deletions, className }: { additions: number; deletions: number; className?: string }) {
  return (
    <span className={cn('font-mono', className)}>
      <span className="text-done">+{additions}</span> <span className="text-fail">−{deletions}</span>
    </span>
  );
}

/** Threads whose file is no longer in the diff at all. */
export function OffDiffThreads({ threads, roundUpId }: { threads: ReviewThread[]; roundUpId: string }) {
  if (!threads.length) return null;
  return (
    <section aria-label="Threads on files no longer changed" className="flex flex-col gap-2.5">
      <h3 className="text-mu2 text-xs">Threads on files no longer changed</h3>
      {threads.map((t) => (
        <div key={t.id} className="flex flex-col gap-1">
          <span className="text-mu2 flex gap-1.5 text-[11px]">
            <FilePath path={t.path} className="text-[11px]" />:{t.line}
          </span>
          <ThreadView thread={t} roundUpId={roundUpId} showHunk />
        </div>
      ))}
    </section>
  );
}

/** A round-up's Changes tab: Kelpie's work tree (the feature branch), the review bar, and every changed file. */
export function ChangesTab({ roundUpId, repo }: { roundUpId: string; repo?: string }) {
  const changes = useChanges(roundUpId);
  const { state } = useReview(roundUpId);
  const nav = useChangesNav();
  const [wrap, toggleWrap] = useDiffWrap('changes');
  const data = changes.data;
  const files = data?.state === 'ready' ? data.files : undefined;
  const collapse = useCollapsed(files);
  const threads = useMemo(() => threadsOn(state?.threads ?? [], 'feature'), [state?.threads]);
  const scope: DiffScope = { roundUpId, view: 'feature', commitSha: anchorSha(data) };

  if (changes.error) return <p className="text-fail text-sm">Couldn't load the changes: {changes.error.message}</p>;
  if (!data) return <p className="text-mu text-sm">Loading changes…</p>;
  if (data.state === 'none' || !files)
    return (
      <div className="flex flex-col gap-6">
        <p className="text-mu bg-well rounded-2xl px-5 py-8 text-center text-sm">No changes yet: writers' work appears here once mustered.</p>
        <OffDiffThreads threads={threads} roundUpId={roundUpId} />
      </div>
    );
  const mustered = data.musteredFrom?.length ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-[15px] font-semibold">Kelpie's work tree</h2>
          {data.branch && (
            <span title={data.baseRef ? `compared with ${data.baseRef}` : undefined} className="bg-chip text-fg2 flex h-6 items-center gap-1.5 rounded-full px-2.5 font-mono text-[11.5px]">
              <GitBranchIcon className="size-3" />
              {data.branch}
            </span>
          )}
        </div>
        <p className="text-mu text-xs">{musteredFromLabel(mustered)}</p>
      </div>

      <ReviewBar roundUpId={roundUpId} />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[15px] font-semibold">Code changes</h3>
          <span className="text-mu font-mono text-xs">
            {filesLabel(data.stats.files)} <Totals additions={data.stats.additions} deletions={data.stats.deletions} />
          </span>
          <span className="flex-1" />
          <WrapToggle wrap={wrap} onToggle={toggleWrap} />
          <button type="button" disabled={!files.length} onClick={() => nav.openFull('feature', files[0]?.path)} className={cn(quietButton, 'h-[30px] text-xs')}>
            <Maximize2Icon className="size-3" />
            Full screen
          </button>
          <button type="button" disabled={!files.length} onClick={() => collapse.setAll(collapse.anyOpen)} className={cn(quietButton, 'h-[30px] text-xs')}>
            {collapse.anyOpen ? 'Collapse all' : 'Expand all'}
          </button>
        </div>
        {repo && (
          <div className="text-mu flex items-center gap-2 text-xs">
            <FolderIcon className="size-3.5" />
            <span className="text-fg2 font-mono">{repo}</span>
            <span>
              {filesLabel(data.stats.files)} · <Totals additions={data.stats.additions} deletions={data.stats.deletions} />
            </span>
          </div>
        )}
        {files.length === 0 && <p className="text-mu text-sm">The feature branch is the same as its base.</p>}
        {files.map((f) => (
          <FileCard
            key={f.path}
            file={f}
            threads={threads}
            scope={scope}
            sessionId={roundUpId}
            wrap={wrap}
            collapsed={collapse.isCollapsed(f.path)}
            onToggle={() => collapse.toggle(f.path)}
            onFullScreen={() => nav.openFull('feature', f.path)}
          />
        ))}
      </div>

      <OffDiffThreads threads={threadsOffDiff(threads, files)} roundUpId={roundUpId} />
    </div>
  );
}
