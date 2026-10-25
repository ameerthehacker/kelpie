import { Maximize2Icon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useChanges } from '@/hooks/use-changes';
import { useChangesNav } from '@/hooks/use-changes-nav';
import { useReview } from '@/hooks/use-review';
import type { AgentSummary } from '@/lib/agents';
import { filesLabel } from '@/lib/changes';
import { reviewCounts, threadsOffDiff, threadsOn } from '@/lib/review';
import { cn } from '@/lib/utils';
import { OffDiffThreads, Totals, useCollapsed } from './changes-tab';
import { FileCard } from './file-card';
import type { DiffScope } from './scope';
import { quietButton } from './thread';

/** An agent's own changes in its pane: its branch against the feature branch, a round at a time. */
export function AgentChanges({ agent: a }: { agent: AgentSummary }) {
  const nav = useChangesNav();
  const [round, setRound] = useState<number | undefined>();
  const changes = useChanges(a.id, { round, working: a.status === 'working' });
  const { state } = useReview(a.parentId);
  const data = changes.data;
  const files = data?.state === 'ready' ? data.files : undefined;
  // Only the first file starts open: the pane is narrow.
  const collapse = useCollapsed(files, 1);
  const threads = useMemo(() => threadsOn(state?.threads ?? [], 'agent', a.id), [state?.threads, a.id]);
  const pending = reviewCounts(state?.threads ?? []).pending;
  const scope: DiffScope = { roundUpId: a.parentId, view: 'agent', viewSessionId: a.id, commitSha: data?.headSha };
  const rounds = data?.rounds ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-[22px] pt-3 pb-4">
      {changes.error && <p className="text-fail text-sm">Couldn't load the changes: {changes.error.message}</p>}
      {!data && !changes.error && <p className="text-mu text-sm">Loading changes…</p>}
      {data?.state === 'none' && <p className="text-mu text-sm">No changes yet.</p>}
      {data && files && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-mu text-xs">
              {filesLabel(data.stats.files)} changed · <Totals additions={data.stats.additions} deletions={data.stats.deletions} />
              {data.dirty && <span title="Includes work not yet committed"> · uncommitted</span>}
            </span>
            <span className="flex-1" />
            {rounds.length > 1 && (
              <select
                aria-label="Round"
                value={data.round ?? ''}
                onChange={(e) => setRound(Number(e.target.value))}
                className="bg-chip text-fg2 h-[30px] rounded-full px-2.5 text-xs outline-none"
              >
                {rounds.map((r) => (
                  <option key={r.index} value={r.index}>
                    Round {r.index}
                    {r.state === 'active' ? ' (now)' : ' (mustered)'}
                  </option>
                ))}
              </select>
            )}
            <button type="button" disabled={!files.length} onClick={() => nav.openFull(a.id, files[0]?.path, round)} className={cn(quietButton, 'h-[30px] text-xs')}>
              <Maximize2Icon className="size-3" />
              Full screen
            </button>
          </div>
          {pending > 0 && (
            <p className="text-mu text-xs">
              {pending} pending comment{pending === 1 ? '' : 's'} ·{' '}
              <button type="button" onClick={() => nav.setTab('changes')} className="text-fg underline-offset-2 hover:underline">
                Submit on the Changes tab
              </button>
            </p>
          )}
          {files.map((f) => (
            <FileCard
              key={f.path}
              compact
              file={f}
              threads={threads}
              scope={scope}
              sessionId={a.id}
              round={round}
              collapsed={collapse.isCollapsed(f.path)}
              onToggle={() => collapse.toggle(f.path)}
              onFullScreen={() => nav.openFull(a.id, f.path, round)}
            />
          ))}
          <OffDiffThreads threads={threadsOffDiff(threads, files)} roundUpId={a.parentId} />
        </>
      )}
    </div>
  );
}
