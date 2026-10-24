import { ListIcon, PanelRightCloseIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { KelpieEvent } from '@kelpie/protocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useEventLog } from '@/hooks/use-agents';
import { useNow } from '@/hooks/use-now';
import { byAttention, elapsed, liveLog, STATUS_LABEL, type AgentSummary, type LogKind } from '@/lib/agents';
import { api } from '@/lib/api';
import { roundUpPath } from '@/lib/round-ups';
import { cn } from '@/lib/utils';
import { HarnessMark } from '@/components/harness-mark';
import { harnessOf } from '@/lib/harnesses';
import { StatusDot, TodoList } from './agent-bits';
import { useAgentPane } from './pane-state';

/** The right-hand pane of an orchestrator round-up: all its agents, and a tab per agent opened. */
export function AgentPane({ agents }: { agents: AgentSummary[] }) {
  const pane = useAgentPane()!;
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const tabs = pane.tabs.filter((id) => byId.has(id));
  const active = pane.active ? byId.get(pane.active) : undefined;

  return (
    <section
      aria-label="Agent pane"
      className="bg-background fixed inset-y-0 right-0 z-40 flex w-full max-w-lg min-w-0 flex-col border-l lg:static lg:z-auto lg:w-[32rem] lg:max-w-[40vw] lg:shrink-0"
    >
      <div role="tablist" aria-label="Open agents" className="flex items-center gap-0.5 overflow-x-auto border-b pt-2 pr-2 pl-2.5">
        <button
          type="button"
          role="tab"
          aria-selected={!active}
          aria-label="All agents"
          onClick={pane.showList}
          className={cn('text-muted-foreground hover:text-foreground flex size-10 shrink-0 items-center justify-center', !active && 'text-foreground shadow-[inset_0_-2px_0_currentColor]')}
        >
          <ListIcon className="size-4" />
        </button>
        {tabs.map((id) => {
          const a = byId.get(id)!;
          const on = id === active?.id;
          return (
            <span key={id} className={cn('flex shrink-0 items-center', on && 'shadow-[inset_0_-2px_0_var(--foreground)]')}>
              <button
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => pane.openAgent(id)}
                className={cn('hover:text-foreground flex h-10 items-center gap-1.5 pr-1.5 pl-3 text-[13px] whitespace-nowrap', on ? 'text-foreground' : 'text-muted-foreground')}
              >
                <StatusDot status={a.status} />
                <span className="max-w-40 truncate">{a.title}</span>
              </button>
              <button
                type="button"
                onClick={() => pane.closeTab(id)}
                aria-label={`Close ${a.title}`}
                className="text-muted-foreground hover:bg-muted hover:text-foreground mr-1.5 flex size-[22px] items-center justify-center rounded"
              >
                <XIcon className="size-3" />
              </button>
            </span>
          );
        })}
        <span className="flex-1" />
        <button
          type="button"
          onClick={pane.close}
          aria-label="Close pane"
          className="text-muted-foreground hover:bg-muted hover:text-foreground mb-1 flex size-8 shrink-0 items-center justify-center rounded-md"
        >
          <PanelRightCloseIcon className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{active ? <AgentView key={active.id} agent={active} /> : <AgentList agents={agents} />}</div>
    </section>
  );
}

function AgentList({ agents }: { agents: AgentSummary[] }) {
  const pane = useAgentPane()!;
  const now = useNow(10_000);
  const sorted = [...agents].sort(byAttention);
  return (
    <div className="flex flex-col px-3 py-3.5">
      <div className="text-muted-foreground px-2.5 pt-1 pb-2.5 text-xs">All agents in this round-up</div>
      {sorted.length === 0 && <p className="text-muted-foreground px-2.5 text-sm">No agents yet. They appear here as the orchestrator starts them.</p>}
      {sorted.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => pane.openAgent(a.id)}
          className="hover:bg-muted/60 grid min-h-14 grid-cols-[18px_1fr_auto] items-center gap-3 rounded-lg px-2.5 py-2 text-left"
        >
          <HarnessMark harness={a.harness} />
          <span className="flex min-w-0 flex-col">
            <span className={cn('truncate text-sm', a.status === 'done' && 'text-muted-foreground')}>{a.title}</span>
            <span className="text-muted-foreground truncate text-[13px]">{a.now || STATUS_LABEL[a.status]}</span>
          </span>
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            {a.status === 'working' ? elapsed(a, now) : STATUS_LABEL[a.status].toLowerCase()}
            <StatusDot status={a.status} />
          </span>
        </button>
      ))}
    </div>
  );
}

const KIND_CLASS: Partial<Record<LogKind, string>> = {
  edit: 'text-blue-600 dark:text-blue-400',
  bash: 'text-violet-600 dark:text-violet-400',
  done: 'text-green-600 dark:text-green-500',
  fail: 'text-destructive',
  task: 'text-amber-600 dark:text-amber-400',
  you: 'text-amber-600 dark:text-amber-400',
};

function AgentView({ agent: a }: { agent: AgentSummary }) {
  const now = useNow(10_000);
  const { events, error } = useEventLog(a.id);
  const log = useMemo(() => liveLog(events), [events]);
  const h = harnessOf(a.harness);

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-col gap-1 px-6 pt-5 pb-3.5">
        <div className="flex items-center gap-2.5">
          <HarnessMark harness={a.harness} size="lg" />
          <h2 className="text-lg font-medium">{a.title}</h2>
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-[13px]">
          <StatusDot status={a.status} />
          {[STATUS_LABEL[a.status], h.name, a.model, a.writes ? 'can edit' : 'read-only', elapsed(a, now)].filter(Boolean).join(' · ')}
        </div>
      </div>
      {a.now && <p className="px-6 pb-4 text-[15px]">{a.now}</p>}

      <section aria-label="Its todos" className="flex flex-col gap-2 border-t px-6 py-4">
        <div className="text-muted-foreground text-xs">Its todos</div>
        {a.todos.length === 0 ? <p className="text-muted-foreground text-sm">No todo list yet.</p> : <TodoList todos={a.todos} className="gap-1.5" />}
      </section>

      <LiveLog events={events} lines={log} error={error} />
      <AgentControls agent={a} />
    </div>
  );
}

function LiveLog({ events, lines, error }: { events: KelpieEvent[]; lines: ReturnType<typeof liveLog>; error: string | undefined }) {
  const end = useRef<HTMLDivElement>(null);
  // Follow the newest line, as a tail would. A block body: scrollIntoView may return a promise,
  // and anything an effect returns is taken for its cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [lines.length]);
  return (
    <section aria-label="Live log" className="flex flex-1 flex-col gap-1 border-t px-6 py-4 font-mono text-xs">
      <div className="text-muted-foreground pb-1 font-sans text-xs">Live</div>
      {error && <p className="text-destructive font-sans text-sm">{error}</p>}
      {events.length === 0 && !error && <p className="text-muted-foreground font-sans text-sm">Loading…</p>}
      {lines.map((l) => (
        <div key={l.id} className="grid grid-cols-[40px_44px_1fr] gap-2.5">
          <span className="text-muted-foreground/70">{l.time}</span>
          <span className={KIND_CLASS[l.kind] ?? 'text-muted-foreground'}>{l.kind}</span>
          <span className="truncate" title={l.text}>
            {l.text}
            {l.delta && (
              <>
                {' '}
                <span className="text-green-600 dark:text-green-500">+{l.delta.added}</span>{' '}
                <span className="text-red-600 dark:text-red-500">−{l.delta.removed}</span>
              </>
            )}
          </span>
        </div>
      ))}
      <div ref={end} />
    </section>
  );
}

/** Talk to the agent directly: a nudge (its orchestrator hears the outcome when it next goes idle), pause, or open its whole session. */
function AgentControls({ agent: a }: { agent: AgentSummary }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);

  const nudge = async (e: FormEvent) => {
    e.preventDefault();
    const message = text.trim();
    if (!message) return;
    setSending(true);
    setError(undefined);
    try {
      await api('POST', `/api/sessions/${a.id}/messages`, { text: message });
      setText('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };
  const pause = () => api('POST', `/api/sessions/${a.id}/interrupt`).catch((err) => setError((err as Error).message));

  return (
    <form onSubmit={nudge} className="bg-background sticky bottom-0 flex flex-wrap items-center gap-2 border-t px-4 pt-3 pb-4 pl-6">
      <label htmlFor="agent-nudge" className="sr-only">
        Message this agent
      </label>
      <Input
        id="agent-nudge"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Nudge or redirect this agent…"
        disabled={sending}
        className="h-9 min-w-0 flex-[1_1_200px]"
      />
      <Button type="button" variant="outline" size="sm" onClick={pause} disabled={a.status !== 'working'}>
        Pause
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={() => navigate(roundUpPath(a.id))}>
        Full session
      </Button>
      {error && <p className="text-destructive w-full text-xs">{error}</p>}
    </form>
  );
}

/** The header's "Agents" toggle: a ring of the round-up's progress, then how many agents are done. */
export function AgentsButton() {
  const pane = useAgentPane();
  if (!pane || pane.agents.length === 0) return null;
  const listOn = pane.open && !pane.active;
  const count = (status: AgentSummary['status']) => pane.agents.filter((a) => a.status === status).length;
  const [done, working, failed] = [count('done'), count('working'), count('failed')];
  const total = pane.agents.length;
  const said = [working && `${working} working`, failed && `${failed} failed`, `${done} of ${total} done`].filter(Boolean).join(', ');
  return (
    <button
      type="button"
      onClick={pane.toggleList}
      aria-pressed={listOn}
      aria-label={`Agents: ${said}`}
      title={said}
      className={cn(
        'hover:bg-muted flex h-8 shrink-0 items-center gap-2 rounded-full border px-3 text-[13px] transition-colors',
        listOn && 'bg-muted border-foreground/25',
      )}
    >
      <ProgressRing total={total} done={done} failed={failed} working={working} />
      Agents
      <span className="text-muted-foreground font-mono text-xs">{done === total ? total : `${done}/${total}`}</span>
    </button>
  );
}

/** Arcs around a ring in order: done (green), failed (red), working (blue, pulsing); the rest is track. */
function ProgressRing({ total, done, failed, working }: { total: number; done: number; failed: number; working: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  let at = 0;
  const arc = (n: number, className: string) => {
    const len = (n / total) * c;
    const el = n > 0 && (
      <circle r={r} cx="8" cy="8" fill="none" strokeWidth="2.5" strokeDasharray={`${len} ${c}`} strokeDashoffset={-at} className={className} />
    );
    at += len;
    return el;
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0 -rotate-90">
      <circle r={r} cx="8" cy="8" fill="none" strokeWidth="2.5" className="stroke-muted-foreground/25" />
      {arc(done, 'stroke-green-500')}
      {arc(failed, 'stroke-destructive')}
      {arc(working, 'animate-pulse stroke-blue-500')}
    </svg>
  );
}

/** The pane when it is open and there is something to show. */
export function AgentPaneSlot() {
  const pane = useAgentPane();
  return pane?.open ? <AgentPane agents={pane.agents} /> : null;
}
