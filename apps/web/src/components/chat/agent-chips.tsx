import { HarnessMark } from '@/components/harness-mark';
import { useAgentPane } from '@/components/agents/pane-state';
import { useOpenSession } from '@/hooks/use-open-session';
import type { AgentSummary } from '@/lib/agents';
import { PROGRESS_LABEL, progressState, type ProgressState } from '@/lib/progress';
import { cn } from '@/lib/utils';

/** Chips a row shows before "+N more". */
export const MAX_CHIPS = 8;

/**
 * The design's status marks: an amber ◆ when it needs the person, a blue dot breathing while it
 * works, a grey ring while queued, a green dot when done; a red dot when it failed, a grey square
 * when stopped. With a `label`, announced as that; otherwise decoration.
 */
export function ProgressMark({ state, label, className }: { state: ProgressState; label?: string; className?: string }) {
  const a11y = label ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': true as const };
  if (state === 'needs-you')
    return (
      <span {...a11y} className={cn('text-wait shrink-0 text-[10px] leading-none', className)}>
        ◆
      </span>
    );
  return (
    <span
      {...a11y}
      className={cn(
        'inline-block size-[7px] shrink-0 rounded-full',
        state === 'working' && 'bg-run motion-safe:animate-k-halo [--k-halo:var(--run)]',
        state === 'queued' && 'border-mu2 border-[1.5px]',
        state === 'done' && 'bg-done',
        state === 'failed' && 'bg-fail',
        state === 'stopped' && 'bg-mu2 rounded-[1.5px]',
        className,
      )}
    />
  );
}

/** One agent as a pill: its harness, its name, and where it stands. Needs-you and failed ones are ringed. */
export function AgentChip({ agent, title, harness, onClick, disabled }: { agent?: AgentSummary; title: string; harness?: string; onClick: () => void; disabled?: boolean }) {
  const pane = useAgentPane();
  const state = agent ? progressState(agent) : 'working';
  const focused = !!agent && pane?.open && pane.active === agent.id;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={focused}
      title={`Open ${agent?.title ?? title}`}
      onClick={onClick}
      className={cn(
        'flex h-[30px] max-w-[16rem] items-center gap-2 rounded-full pr-3 pl-1.5 text-[13px] transition-colors disabled:opacity-60',
        focused ? 'bg-raise text-fg' : 'bg-chip text-fg2 hover:bg-raise',
        state === 'needs-you' && 'shadow-[inset_0_0_0_1px_var(--wait)]',
        state === 'failed' && 'shadow-[inset_0_0_0_1px_var(--fail)]',
      )}
    >
      <HarnessMark harness={agent?.harness ?? harness ?? 'claude-code'} />
      <span className="min-w-0 truncate">{agent?.title ?? title}</span>
      <ProgressMark state={state} label={PROGRESS_LABEL[state]} />
    </button>
  );
}

/** Opens an agent in the pane, or, one the pane hasn't loaded, on its own page. */
export function useOpenAgent() {
  const pane = useAgentPane();
  const openSession = useOpenSession();
  return (id: string) => (pane?.agents.some((a) => a.id === id) ? pane.openAgent(id) : openSession(id));
}

/** A row of agents as chips, capped: the rest are "+N more", which opens the pane's list. */
export function AgentChips({ agents, max = MAX_CHIPS, className }: { agents: readonly AgentSummary[]; max?: number; className?: string }) {
  const pane = useAgentPane();
  const open = useOpenAgent();
  const more = agents.length - max;
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {agents.slice(0, max).map((a) => (
        <AgentChip key={a.id} agent={a} title={a.title} onClick={() => open(a.id)} />
      ))}
      {more > 0 && (
        <button type="button" onClick={() => pane?.showList()} className="text-mu hover:text-fg px-1 text-[13px] underline-offset-2 hover:underline">
          +{more} more
        </button>
      )}
    </div>
  );
}
