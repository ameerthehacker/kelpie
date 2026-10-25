import { ChevronDownIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { TodoItem } from '@kelpie/protocol';
import { HarnessMark } from '@/components/harness-mark';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { byAttention, planProgress, STATUS_LABEL, type AgentSummary } from '@/lib/agents';
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
function Dock({ title, bar, summary, children }: { title: string; bar: ReactNode; summary: ReactNode; children: ReactNode }) {
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
        <ChevronDownIcon className={cn('text-mu2 size-4 shrink-0 transition-transform', !open && '-rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-ln max-h-[min(18rem,35vh)] overflow-y-auto border-t px-2 py-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The orchestrator's plan: each agent with the todos it is working through. Opening an
 * agent shows it in the agent pane.
 */
export function PlanDock() {
  const pane = useAgentPane();
  if (!pane || pane.agents.length === 0) return null;
  const agents = [...pane.agents].sort(byAttention);
  const p = planProgress(agents);
  const working = agents.find((a) => a.status === 'working');
  return (
    <Dock
      title="Plan"
      bar={<Segments agents={agents} />}
      summary={
        <>
          {p.agentsDone}/{p.agents} agents done
          {p.steps > 0 && ` · ${p.stepsDone}/${p.steps} todos`}
          {working?.now && ` · ${working.title}: ${working.now}`}
        </>
      }
    >
      <ul className="flex flex-col">
        {agents.map((a) => (
          <AgentRow key={a.id} agent={a} onOpen={() => pane.openAgent(a.id)} />
        ))}
      </ul>
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

/** One bar segment per agent, so the plan's shape shows even when collapsed. */
function Segments({ agents }: { agents: AgentSummary[] }) {
  return (
    <span aria-hidden="true" className="flex w-24 shrink-0 gap-0.5">
      {agents.map((a) => (
        <span
          key={a.id}
          className={cn(
            'h-1 flex-1 rounded-full',
            a.status === 'done' && 'bg-done',
            a.status === 'working' && 'bg-run animate-k-pulse',
            a.status === 'needs-approval' && 'bg-wait animate-k-pulse',
            a.status === 'failed' && 'bg-fail',
            (a.status === 'idle' || a.status === 'stopped') && 'bg-ln2',
          )}
        />
      ))}
    </span>
  );
}

function AgentRow({ agent: a, onOpen }: { agent: AgentSummary; onOpen: () => void }) {
  const done = a.todos.filter((t) => t.status === 'completed').length;
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
          <span className={cn('shrink-0 truncate', a.status === 'done' ? 'text-mu' : 'text-fg')}>{a.title}</span>
          <span className="text-mu truncate text-xs">{a.now || STATUS_LABEL[a.status]}</span>
        </span>
        <span className="text-mu2 flex items-center gap-1.5 text-xs">
          {a.todos.length > 0 && (
            <span className="font-mono">
              {done}/{a.todos.length}
            </span>
          )}
          <StatusDot status={a.status} />
        </span>
      </button>
      {a.todos.length > 0 && <TodoList todos={a.todos} label={`${a.title}’s todos`} className="border-ln mb-1.5 ml-[33px] border-l pt-0.5 pl-3" />}
    </li>
  );
}
