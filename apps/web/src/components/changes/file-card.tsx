import { ChevronRightIcon, Maximize2Icon } from 'lucide-react';
import { Suspense, useEffect, useRef, useState } from 'react';
import { HarnessMark } from '@/components/harness-mark';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useChangedFile } from '@/hooks/use-changes';
import { splitPath, statSquares, type ChangedFile } from '@/lib/changes';
import type { AgentRef, ReviewThread } from '@/lib/review';
import { cn } from '@/lib/utils';
import { LazyDiffView, type DiffScope } from './scope';
import { quietButton, ThreadStrip } from './thread';

/** `billing-api/` muted, then **package.json**. */
export function FilePath({ path, className }: { path: string; className?: string }) {
  const { dir, base } = splitPath(path);
  return (
    <span title={path} className={cn('min-w-0 truncate font-mono text-[12.5px]', className)}>
      <span className="text-mu">{dir}</span>
      <span className="text-fg font-semibold">{base}</span>
    </span>
  );
}

/** Who changed a file, a harness mark each. */
export function AgentBadges({ agents }: { agents: AgentRef[] }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {agents.map((a, i) => (
        <Tooltip key={a.id ?? `${a.title}-${i}`}>
          <TooltipTrigger asChild>
            <span className="flex">
              <HarnessMark harness={a.harness} />
            </span>
          </TooltipTrigger>
          <TooltipContent>Changed by {a.title}</TooltipContent>
        </Tooltip>
      ))}
    </span>
  );
}

/** `+3 −1`, and optionally GitHub's five squares. */
export function FileStat({ additions, deletions, squares }: { additions: number; deletions: number; squares?: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-[11.5px]" aria-label={`${additions} added, ${deletions} removed`}>
      <span className="text-done">+{additions}</span>
      <span className="text-fail">−{deletions}</span>
      {squares && (
        <span aria-hidden="true" className="flex gap-px">
          {statSquares(additions, deletions).map((s, i) => (
            <span key={i} className={cn('size-[7px] rounded-[1.5px]', s === 'add' ? 'bg-done' : s === 'del' ? 'bg-fail' : 'bg-ln2')} />
          ))}
        </span>
      )}
    </span>
  );
}

/** True once the element has come near the viewport; it stays true. */
function useSeen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

/**
 * A file's diff and the review on it. Binary files have none; a file too large to come with the
 * rest is fetched when asked for.
 */
export function FileBody({ file, threads, scope, sessionId, round }: { file: ChangedFile; threads: ReviewThread[]; scope: DiffScope; sessionId: string; round?: number }) {
  const [load, setLoad] = useState(false);
  const big = useChangedFile(sessionId, file.path, round, load && !!file.tooLarge);
  const patch = file.patch ?? big.data?.patch;
  const mine = threads.filter((t) => t.path === file.path);
  if (patch)
    return (
      <Suspense fallback={<p className="text-mu px-4 py-3 text-[13px]">Loading diff…</p>}>
        <LazyDiffView file={file} patch={patch} threads={mine} scope={scope} />
      </Suspense>
    );
  return (
    <>
      <ThreadStrip threads={mine} roundUpId={scope.roundUpId} />
      <div className="text-mu flex items-center gap-3 px-4 py-3 text-[13px]">
        {file.binary ? (
          'Binary file'
        ) : file.tooLarge ? (
          <>
            <span>This diff is large.</span>
            <button type="button" disabled={big.isFetching} onClick={() => setLoad(true)} className={quietButton}>
              {big.isFetching ? 'Loading…' : 'Load diff'}
            </button>
            {big.error && <span className="text-fail">{big.error.message}</span>}
          </>
        ) : file.status === 'renamed' ? (
          `Renamed from ${file.oldPath}`
        ) : (
          'No line changes'
        )}
      </div>
    </>
  );
}

/**
 * A changed file: its header (path, who changed it, how much) and, once it scrolls near, its diff.
 * `compact` is the agent pane's: no harness marks or squares.
 */
export function FileCard({
  file,
  threads,
  scope,
  sessionId,
  round,
  collapsed,
  onToggle,
  onFullScreen,
  compact,
}: {
  file: ChangedFile;
  threads: ReviewThread[];
  scope: DiffScope;
  sessionId: string;
  round?: number;
  collapsed: boolean;
  onToggle: () => void;
  onFullScreen: () => void;
  compact?: boolean;
}) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const count = threads.filter((t) => t.path === file.path && t.status !== 'resolved').length;
  return (
    <div ref={ref} className="border-ln2 bg-background overflow-hidden rounded-xl border" data-file={file.path}>
      <div className={cn('flex h-11 items-center gap-2.5 pr-2 pl-3', !collapsed && 'border-ln border-b')}>
        <button type="button" aria-expanded={!collapsed} onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronRightIcon className={cn('text-mu2 size-3.5 shrink-0 transition-transform', !collapsed && 'rotate-90')} strokeWidth={2.2} />
          <FilePath path={file.path} />
          {file.status === 'added' && <span className="text-done shrink-0 text-[11px]">new</span>}
          {file.status === 'deleted' && <span className="text-fail shrink-0 text-[11px]">deleted</span>}
          {count > 0 && (
            <span title={`${count} open thread${count === 1 ? '' : 's'}`} className="bg-chip text-mu shrink-0 rounded-full px-1.5 font-mono text-[10.5px]">
              {count}
            </span>
          )}
        </button>
        {!compact && <AgentBadges agents={file.agents} />}
        <FileStat additions={file.additions} deletions={file.deletions} squares={!compact} />
        <button type="button" onClick={onFullScreen} aria-label={`Open ${file.path} full screen`} title="Full screen" className="text-mu2 hover:bg-hov hover:text-fg flex size-7 shrink-0 items-center justify-center rounded-lg">
          <Maximize2Icon className="size-3.5" />
        </button>
      </div>
      {!collapsed && (seen ? <FileBody file={file} threads={threads} scope={scope} sessionId={sessionId} round={round} /> : <div className="h-24" />)}
    </div>
  );
}
