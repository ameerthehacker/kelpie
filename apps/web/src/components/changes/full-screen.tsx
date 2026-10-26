import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, CodeXmlIcon, Minimize2Icon } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useAgentPane } from '@/components/agents/pane-state';
import { HarnessMark } from '@/components/harness-mark';
import { useChanges } from '@/hooks/use-changes';
import { useChangesNav } from '@/hooks/use-changes-nav';
import { useReview } from '@/hooks/use-review';
import { anchorSha, filesLabel, groupByDir, neighbors, splitPath, vscodeUrl } from '@/lib/changes';
import { threadsOn } from '@/lib/review';
import { cn } from '@/lib/utils';
import { FileBody, FilePath, FileStat } from './file-card';
import { ReviewBar } from './review-bar';
import type { DiffScope } from './scope';

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/**
 * One diff full screen, a file at a time: the feature's (`which` = 'feature') or an agent's. Esc
 * or Back leaves it; ←/→ step through the files.
 */
export function FullScreen({ roundUpId, roundUpTitle, which }: { roundUpId: string; roundUpTitle: string; which: string }) {
  const nav = useChangesNav();
  const agent = useAgentPane()?.agents.find((a) => a.id === which);
  const feature = which === 'feature';
  const sessionId = feature ? roundUpId : which;
  const changes = useChanges(sessionId, { round: feature ? undefined : nav.round, working: agent?.status === 'working' });
  const { state } = useReview(roundUpId);
  const files = changes.data?.state === 'ready' ? changes.data.files : [];
  const at = neighbors(files, nav.file ?? files[0]?.path);
  const file = at.current;
  const threads = useMemo(() => threadsOn(state?.threads ?? [], feature ? 'feature' : 'agent', sessionId), [state?.threads, feature, sessionId]);
  const scope: DiffScope = {
    roundUpId,
    view: feature ? 'feature' : 'agent',
    commitSha: anchorSha(changes.data, feature ? undefined : nav.round),
    ...(feature ? {} : { viewSessionId: sessionId }),
  };
  const name = feature ? roundUpTitle : (agent?.title ?? 'agent');
  const href = file && vscodeUrl(changes.data?.checkoutPath, file.path);
  const list = useRef<HTMLDivElement>(null);

  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    // A popover (the review's) closes on its own Esc first.
    if (e.key === 'Escape' && !document.querySelector('[data-slot="popover-content"]')) nav.closeFull();
    else if (e.key === 'ArrowLeft' && at.prev) nav.showFile(at.prev.path);
    else if (e.key === 'ArrowRight' && at.next) nav.showFile(at.next.path);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  useEffect(() => {
    list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [file?.path]);

  return (
    <div role="dialog" aria-modal="true" aria-label={`${name} · Changes`} className="bg-background shadow-card fixed inset-2.5 z-50 flex flex-col overflow-hidden rounded-3xl max-sm:inset-0 max-sm:rounded-none">
      <header className="border-ln flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <button type="button" onClick={nav.closeFull} className="bg-chip hover:bg-raise flex h-9 max-w-64 shrink-0 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium">
          <ArrowLeftIcon className="size-3.5 shrink-0" />
          <span className="truncate">Back to {name}</span>
        </button>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate text-sm font-semibold">{name} · Changes</h2>
          <span className="text-mu text-xs">{filesLabel(files.length)} changed</span>
        </div>
        {feature && <ReviewBar roundUpId={roundUpId} compact className="shrink-0 flex-nowrap bg-transparent py-0" />}
        <span className="text-mu flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap max-xl:hidden">
          <kbd className="bg-chip text-fg2 rounded-md px-1.5 py-0.5 font-mono text-[11px]">Esc</kbd> to go back
        </span>
        <button type="button" onClick={nav.closeFull} aria-label="Leave full screen" title="Leave full screen" className="text-mu2 hover:bg-hov hover:text-fg flex size-8 items-center justify-center rounded-full">
          <Minimize2Icon className="size-3.5" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav ref={list} aria-label="Changed files" className="bg-side border-ln flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-r p-2.5 max-md:hidden">
          {changes.error && <p className="text-fail px-2 text-xs">{changes.error.message}</p>}
          {groupByDir(files).map((g) => (
            <div key={g.dir} className="flex flex-col gap-0.5">
              <div className="text-mu2 truncate px-2 pb-0.5 font-mono text-[11px]">{g.dir || './'}</div>
              {g.files.map((f) => {
                const on = f.path === file?.path;
                return (
                  <button
                    key={f.path}
                    type="button"
                    aria-current={on}
                    onClick={() => nav.showFile(f.path)}
                    className={cn('flex items-start gap-2 rounded-xl px-2 py-1.5 text-left', on ? 'bg-background shadow-[inset_0_0_0_1px_var(--ln2)]' : 'hover:bg-hov')}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-fg truncate font-mono text-[12px]">{splitPath(f.path).base}</span>
                      {g.dir && <span className="text-mu2 truncate font-mono text-[11px]">{g.dir}</span>}
                    </span>
                    <FileStat additions={f.additions} deletions={f.deletions} />
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <section aria-label={file?.path ?? 'File'} className="flex min-w-0 flex-1 flex-col">
          {file ? (
            <>
              <div className="border-ln flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2.5">
                {file.agents[0] && <HarnessMark harness={file.agents[0].harness} />}
                <FilePath path={file.path} className="flex-1" />
                {file.agents.length > 0 && <span className="text-mu text-xs">Changed by {file.agents.map((a) => a.title).join(', ')}</span>}
                <FileStat additions={file.additions} deletions={file.deletions} />
                <span className="text-mu flex items-center gap-0.5 font-mono text-xs">
                  <button type="button" disabled={!at.prev} onClick={() => at.prev && nav.showFile(at.prev.path)} aria-label="Previous file" className="hover:text-fg flex size-6 items-center justify-center rounded-full disabled:opacity-35">
                    <ChevronLeftIcon className="size-3.5" />
                  </button>
                  {at.index + 1} of {at.total}
                  <button type="button" disabled={!at.next} onClick={() => at.next && nav.showFile(at.next.path)} aria-label="Next file" className="hover:text-fg flex size-6 items-center justify-center rounded-full disabled:opacity-35">
                    <ChevronRightIcon className="size-3.5" />
                  </button>
                </span>
                {href && (
                  <a href={href} className="bg-chip hover:bg-raise flex h-8 items-center gap-1.5 rounded-full px-3 text-xs">
                    <CodeXmlIcon className="text-run size-3.5" />
                    Open in VS Code
                  </a>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <FileBody key={file.path} file={file} threads={threads} scope={scope} sessionId={sessionId} round={feature ? undefined : nav.round} />
              </div>
            </>
          ) : (
            <p className="text-mu p-6 text-sm">{changes.isPending ? 'Loading changes…' : 'No changed files.'}</p>
          )}
        </section>
      </div>
    </div>
  );
}
