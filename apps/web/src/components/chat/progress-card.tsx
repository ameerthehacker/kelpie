import { FileDiffIcon, FileTextIcon } from 'lucide-react';
import { useMemo } from 'react';
import type { AgentUpdate } from '@kelpie/protocol';
import { useAgentPane } from '@/components/agents/pane-state';
import { KelpieLogo } from '@/components/shell/brand';
import { useChangesNav } from '@/hooks/use-changes-nav';
import { useNow } from '@/hooks/use-now';
import { DELIVERABLE_STATE, PROGRESS_LABEL, PROGRESS_ORDER, progressOf, progressState, type Deliverable, type ProgressState, type Segment } from '@/lib/progress';
import { chatWhen } from '@/lib/workbench';
import { cn } from '@/lib/utils';
import { AgentChips, ProgressMark } from './agent-chips';

/** Finished work the card lists before "+N more". */
const READY_SHOWN = 3;
/** Agents waiting on the person or failed, called out as chips. */
const CALLED_OUT = 6;

const SEGMENT: Record<ProgressState, string> = {
  done: 'bg-done',
  'needs-you': 'bg-wait',
  working: 'bg-run',
  queued: 'bg-ln2',
  failed: 'bg-fail',
  stopped: 'bg-mu2',
};

/**
 * The round-up's agents in one card, kept up to date in place as they move (from their live
 * state, not the updates piled up in the chat): how many are done, a bar with a segment each,
 * what has finished and is ready for the person, and who is still at it. Nothing without agents.
 * `updates`: each agent's latest report, for what its work was.
 */
export function ProgressCard({ updates }: { updates?: ReadonlyMap<string, AgentUpdate> }) {
  const pane = useAgentPane();
  const agents = pane?.agents;
  const now = useNow();
  const p = useMemo(() => progressOf(agents ?? [], updates), [agents, updates]);
  const attention = useMemo(() => (agents ?? []).filter((a) => {
    const s = progressState(a);
    return s === 'needs-you' || s === 'failed';
  }), [agents]);
  if (!pane || !p.total) return null;
  const when = p.lastChange ? chatWhen(p.lastChange, now) : undefined;
  return (
    <section aria-label="Progress" className="not-prose bg-surf border-ln flex flex-col gap-3.5 rounded-2xl border p-4">
      <header className="flex items-center gap-3">
        <KelpieLogo className="size-8" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold">Progress</span>
          <span className="text-mu2 truncate text-xs">One card that Kelpie keeps up to date{when && ` · last change ${when}`}</span>
        </div>
        <span className="text-mu shrink-0 font-mono text-xs">
          {p.done}/{p.total} done
        </span>
      </header>
      <Bar segments={p.segments} counts={p.counts} />
      {attention.length > 0 && <AgentChips agents={attention} max={CALLED_OUT} />}
      {p.ready.length > 0 && <Ready ready={p.ready} onMore={pane.showList} />}
      <p className="text-mu flex items-center gap-2 text-[13px]">
        <ProgressMark state={p.footer.tone} />
        <span className="min-w-0">
          {p.footer.text}
          {p.finished && when && ` · ${when}`}
        </span>
      </p>
    </section>
  );
}

/** A 3px segment per agent, coloured by where it stands; past the cap, a run per state. */
function Bar({ segments, counts }: { segments: Segment[]; counts: Record<ProgressState, number> }) {
  const label = PROGRESS_ORDER.flatMap((s) => (counts[s] ? [`${counts[s]} ${PROGRESS_LABEL[s].toLowerCase()}`] : [])).join(', ');
  return (
    <div role="img" aria-label={label} title={label} className="flex h-[3px] gap-[3px]">
      {segments.map((s, i) => (
        <span key={i} title={s.title ? `${s.title} · ${PROGRESS_LABEL[s.state]}` : undefined} className={cn('h-full min-w-[3px] rounded-full', SEGMENT[s.state])} style={{ flexGrow: s.size }} />
      ))}
    </div>
  );
}

/** "Ready for you · n": the newest finished work, each opening it; the rest in the pane's list. */
function Ready({ ready, onMore }: { ready: Deliverable[]; onMore: () => void }) {
  const more = ready.length - READY_SHOWN;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-mu2 text-xs">Ready for you · {ready.length}</span>
      <ul className="flex flex-col gap-1.5">
        {ready.slice(0, READY_SHOWN).map((d) => (
          <ReadyRow key={d.agentId} item={d} />
        ))}
      </ul>
      {more > 0 && (
        <button type="button" onClick={onMore} className="text-mu hover:text-fg self-start text-xs underline-offset-2 hover:underline">
          +{more} more
        </button>
      )}
    </div>
  );
}

function ReadyRow({ item }: { item: Deliverable }) {
  const pane = useAgentPane();
  const nav = useChangesNav();
  const changes = item.kind === 'changes';
  // Until artifacts have a panel of their own: a writer's changes full screen, a report in the agent's tab.
  const open = () => (changes ? nav.openFull(item.agentId) : pane?.openAgent(item.agentId));
  const Icon = changes ? FileDiffIcon : FileTextIcon;
  return (
    <li>
      <button type="button" onClick={open} className="bg-chip/60 hover:bg-chip flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left">
        <span aria-hidden="true" className={cn('bg-surf flex size-7 shrink-0 items-center justify-center rounded-lg', changes ? 'text-run' : 'text-acc')}>
          <Icon className="size-3.5" strokeWidth={2.2} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-fg truncate text-[13px] font-medium">{item.title}</span>
          <span className="text-mu2 truncate text-xs">
            {changes ? 'Code changes' : 'Report'}
            {item.detail && ` · ${item.detail}`}
          </span>
        </span>
        <span className={cn('bg-chip shrink-0 rounded-full px-2 py-0.5 text-[11px]', item.state === 'review' ? 'text-acc' : 'text-mu')}>{DELIVERABLE_STATE[item.state]}</span>
      </button>
    </li>
  );
}
