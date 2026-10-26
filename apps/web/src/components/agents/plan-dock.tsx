import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { TodoItem } from '@kelpie/protocol';
import { HarnessMark } from '@/components/harness-mark';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useApprovals } from '@/hooks/use-approvals';
import { useMaxAgents } from '@/hooks/use-settings';
import { planProgress, type AgentSummary } from '@/lib/agents';
import { isPlan, isQuestion } from '@/lib/approvals';
import { planBar, planLabel, planSections, type PlanBar, type PlanOpts } from '@/lib/plan';
import { planGroup, type PlanGroup } from '@/lib/status';
import { workingLabel } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { StatusDot, TodoList } from './agent-bits';
import { useAgentPane } from './pane-state';

const OPEN_KEY = 'kelpie.plan-dock.open';

const remembered = () => {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
};

/** A panel docked above the composer, outside the chat flow; open or collapsed as the viewer last left it. */
function Dock({ title, bar, summary, end, children }: { title: string; bar: ReactNode; summary: ReactNode; end?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(remembered);
  const toggle = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {}
  };
  return (
    <Collapsible open={open} onOpenChange={toggle} className="bg-surf border-ln mb-2 rounded-[20px] border text-sm">
      <CollapsibleTrigger className="hover:bg-hov flex w-full items-center gap-3 rounded-[20px] px-4 py-2.5 text-left">
        <span className="font-medium">{title}</span>
        {bar}
        <span className="text-mu min-w-0 flex-1 truncate text-xs">{summary}</span>
        {end && <span className="text-mu2 shrink-0 text-xs">{end}</span>}
        <ChevronDownIcon className={cn('text-mu2 size-4 shrink-0 transition-transform', !open && '-rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-ln max-h-[min(18rem,35vh)] overflow-y-auto border-t px-2 py-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const NO_AGENTS: AgentSummary[] = [];

/**
 * The orchestrator's plan. Collapsed: a dot per agent that needs tracking (waiting on the person,
 * failed, working), what the most urgent one is doing, and finished agents as a count. Open: the
 * active agents with their todos, and the finished ones folded into "Done". Opening an agent shows
 * it in the agent pane. `settledAt`: the orchestrator's last activity, so agents are grouped as
 * the round-up's dot groups them (see `planGroup`).
 */
export function PlanDock({ settledAt }: { settledAt?: number }) {
  const pane = useAgentPane();
  const approvals = useApprovals();
  const agents = pane?.agents ?? NO_AGENTS;
  const limit = useMaxAgents();
  const opts = useMemo((): PlanOpts => {
    const titles = new Map(agents.map((a) => [a.id, a.title]));
    const asking = (is: typeof isPlan) => new Set(approvals.filter(is).map((a) => a.sessionId));
    return { plans: asking(isPlan), questions: asking(isQuestion), nameOf: (id: string) => titles.get(id), settledAt };
  }, [agents, approvals, settledAt]);
  if (!pane || agents.length === 0) return null;
  const bar = planBar(agents, opts);
  const { active, done } = planSections(agents, settledAt);
  const p = planProgress(agents);
  const working = agents.filter((a) => a.status === 'working' || a.status === 'needs-approval').length;
  const row = (a: AgentSummary) => (
    <AgentRow key={a.id} agent={a} group={planGroup(a, settledAt)} label={planLabel(a, opts)} onOpen={() => pane.openAgent(a.id)} />
  );
  return (
    <Dock title="Plan" bar={<Dots bar={bar} />} summary={bar.text} end={bar.counts.join(' · ')}>
      <p className="text-mu2 px-2 pb-1 text-xs">
        {p.agents} agent{p.agents === 1 ? '' : 's'}{working > 0 && ` · ${workingLabel(working, limit)}`}
        {p.steps > 0 && ` · ${p.stepsDone}/${p.steps} todos done`}
      </p>
      {active.length > 0 && <ul className="flex flex-col">{active.map(row)}</ul>}
      {done.length > 0 && (
        <Collapsible defaultOpen={active.length === 0}>
          <CollapsibleTrigger className="group/done text-mu hover:bg-hov flex w-full items-center gap-1.5 rounded-xl px-2 py-1.5 text-left text-xs">
            <ChevronRightIcon aria-hidden="true" className="text-mu2 size-3.5 transition-transform group-data-[state=open]/done:rotate-90" />
            Done ({done.length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="flex flex-col">{done.map(row)}</ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Dock>
  );
}

/** A round-up's own todo list (a sub-agent's page, or an older round-up), docked the same way. */
export function TodoDock({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress');
  return (
    <Dock
      title="Todos"
      bar={
        <span aria-hidden="true" className="bg-ln2 h-1 w-24 shrink-0 overflow-hidden rounded-full">
          <span className="bg-done block h-full rounded-full" style={{ width: `${(done / todos.length) * 100}%` }} />
        </span>
      }
      summary={
        <>
          {done}/{todos.length} done
          {current && ` · ${current.activeText ?? current.text}`}
        </>
      }
    >
      <TodoList todos={todos} className="px-2 py-1" />
    </Dock>
  );
}

/** A dot per agent that needs tracking, capped: the plan's live shape, even collapsed. */
function Dots({ bar }: { bar: PlanBar }) {
  if (bar.dots.length === 0) return null;
  return (
    // Room between the dots for their halos.
    <span role="img" aria-label={bar.label} title={bar.label} className="flex shrink-0 items-center gap-1.5">
      {bar.dots.map(({ agent, group }) => (
        <StatusDot key={agent.id} status={group} />
      ))}
      {bar.more > 0 && <span className="text-mu2 ml-0.5 font-mono text-[11px]">+{bar.more}</span>}
    </span>
  );
}

function AgentRow({ agent: a, group, label, onOpen }: { agent: AgentSummary; group: PlanGroup; label: string; onOpen: () => void }) {
  const done = a.todos.filter((t) => t.status === 'completed').length;
  // Todos only while they are live; a finished agent's are in its tab.
  const live = group === 'needs-you' || group === 'failed' || group === 'working';
  return (
    <li className="flex flex-col">
      <button
        type="button"
        onClick={onOpen}
        title={`Open ${a.title} in the agent pane`}
        className="hover:bg-hov grid grid-cols-[18px_1fr_auto] items-center gap-2.5 rounded-xl px-2 py-1.5 text-left"
      >
        <HarnessMark harness={a.harness} />
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={cn('shrink-0 truncate', group === 'done' ? 'text-mu' : 'text-fg')}>{a.title}</span>
          <span className={cn('truncate text-xs', group === 'needs-you' ? 'text-wait' : group === 'failed' ? 'text-fail' : 'text-mu')}>{label}</span>
        </span>
        <span className="text-mu2 flex items-center gap-1.5 text-xs">
          {a.todos.length > 0 && (
            <span className="font-mono">
              {done}/{a.todos.length}
            </span>
          )}
          <StatusDot status={group} />
        </span>
      </button>
      {live && a.todos.length > 0 && <TodoList todos={a.todos} label={`${a.title}’s todos`} className="border-ln mb-1.5 ml-[33px] border-l pt-0.5 pl-3" />}
    </li>
  );
}
