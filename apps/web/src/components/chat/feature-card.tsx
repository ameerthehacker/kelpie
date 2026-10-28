import { LayersIcon } from 'lucide-react';
import { Link } from 'react-router';
import { workbenchPath, type WorkbenchAgentStatus, type WorkbenchItem } from '@kelpie/protocol';
import { HarnessMark } from '@/components/harness-mark';
import { TicketChips } from '@/components/shell/tickets';
import { useNow } from '@/hooks/use-now';
import { useWorkbench } from '@/hooks/use-workbench';
import type { ProgressState } from '@/lib/progress';
import { chatWhen, pillOf, STAGES, tally, topItems } from '@/lib/workbench';
import { cn } from '@/lib/utils';
import { ProgressMark } from './agent-chips';

/** Tasks the card lists; the rest are tallied under them. */
const SHOWN = 6;

const MARK: Record<WorkbenchAgentStatus, ProgressState> = {
  'needs-approval': 'needs-you',
  working: 'working',
  done: 'done',
  failed: 'failed',
  idle: 'queued',
  paused: 'queued',
  halted: 'stopped',
  stopped: 'stopped',
};

const STAGE_PILL: Record<string, string> = { blocked: 'bg-wbg text-wait', ready: 'bg-chip text-acc', done: 'bg-chip text-mu' };

/** An item's mark: merged is done whatever its agent says; without an agent, it waits. */
const markOf = (item: WorkbenchItem): ProgressState => (item.status === 'merged' ? 'done' : item.agentStatus ? MARK[item.agentStatus] : 'queued');

/**
 * The feature Kelpie organised the work into, where it did (its `create_card` step), live from the
 * Workbench: its tickets and stage, a row per task with its agent and where its work stands, and
 * the way to the board. Nothing until the board has the card, or once it is gone.
 */
export function FeatureCard({ cardId }: { cardId: string }) {
  const { cards } = useWorkbench();
  const now = useNow();
  const card = cards?.find((c) => c.id === cardId);
  if (!card) return null;
  const stage = STAGES.find((s) => s.stage === card.stage);
  const rest = tally(card.items, SHOWN);
  return (
    <section aria-label={`Feature: ${card.title}`} className="not-prose bg-surf border-ln flex flex-col gap-3 rounded-2xl border p-4">
      <header className="flex flex-col gap-1.5">
        <span className="text-mu2 flex items-center gap-1.5 text-xs">
          <LayersIcon aria-hidden="true" className="size-3.5" strokeWidth={2} />
          Feature · {card.items.length} task{card.items.length === 1 ? '' : 's'}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold">{card.title}</span>
          <TicketChips tickets={card.tickets} />
          {stage && <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', STAGE_PILL[card.stage] ?? 'bg-chip text-fg2')}>{stage.label}</span>}
        </div>
      </header>
      {card.items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {topItems(card.items, SHOWN).map((item) => (
            <TaskRow key={item.key} item={item} />
          ))}
        </ul>
      )}
      {rest && card.items.length > SHOWN && <p className="text-mu2 text-xs">{rest}</p>}
      <footer className="text-mu2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span>Organized by Kelpie from your message · {chatWhen(card.createdAt, now)}</span>
        <Link to={workbenchPath(card.id)} className="text-fg2 hover:text-fg ml-auto font-medium">
          Open in Workbench →
        </Link>
      </footer>
    </section>
  );
}

function TaskRow({ item }: { item: WorkbenchItem }) {
  const pill = pillOf(item.status);
  const mark = markOf(item);
  return (
    <li className="grid grid-cols-[12px_1fr_auto] items-start gap-x-2.5 text-[13px]">
      <span className="flex h-5 items-center justify-center">
        <ProgressMark state={mark} label={mark === 'needs-you' ? 'Needs you' : undefined} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-fg truncate">{item.title}</span>
        {item.agentTitle && (
          <span className="text-mu2 flex min-w-0 items-center gap-1.5 text-xs">
            {item.harness && <HarnessMark harness={item.harness} className="size-3.5" />}
            <span className="truncate">{item.agentTitle}</span>
          </span>
        )}
      </span>
      {/* Its PR, or what the orchestrator says of it; a task nobody has started is just queued. */}
      {mark === 'queued' && item.status === 'draft' && !item.ref ? (
        <span className="text-mu2 text-xs">Queued</span>
      ) : (
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] whitespace-nowrap', pill.className)}>
          {item.ref && `${item.ref} `}
          {pill.label}
        </span>
      )}
    </li>
  );
}
