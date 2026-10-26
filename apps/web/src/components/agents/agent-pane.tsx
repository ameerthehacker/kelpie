import { format } from 'date-fns';
import { ArrowUpIcon, ChevronRightIcon, ExternalLinkIcon, GitBranchIcon, ListIcon, PauseIcon, PlayIcon, SearchIcon, SquareIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { KelpieEvent } from '@kelpie/protocol';
import { HarnessMark } from '@/components/harness-mark';
import { MessageResponse } from '@/components/ai-elements/message';
import { ApprovalRow } from '@/components/approvals/approval-row';
import { useGroupAnswers } from '@/components/approvals/approval-tray';
import { AttachButton, AttachmentChips, FileChips, useAttachedFiles } from '@/components/chat/attachments';
import { EventLine } from '@/components/chat/events';
import { HaltLine, LimitLine, PausedBanner, ResumedLine } from '@/components/chat/limit-banner';
import { Button } from '@/components/ui/button';
import { useResumeAgent } from '@/hooks/use-halt';
import { QuestionCard } from '@/components/chat/question-card';
import { ShowCommandsToggle, StepRow } from '@/components/chat/steps';
import { useEventLog } from '@/hooks/use-agents';
import { useApprovals } from '@/hooks/use-approvals';
import { useChanges } from '@/hooks/use-changes';
import { AgentChanges } from '@/components/changes/agent-changes';
import { TabStrip } from '@/components/changes/tab-strip';
import { groupApprovals } from '@/lib/approvals';
import { useNow } from '@/hooks/use-now';
import { useOpenSession } from '@/hooks/use-open-session';
import { useMaxAgents } from '@/hooks/use-settings';
import { byAttention, elapsed, STATUS_LABEL, STATUS_ORDER, type AgentStatus, type AgentSummary } from '@/lib/agents';
import { api } from '@/lib/api';
import { buildChat } from '@/lib/chat';
import { unechoed, type SentMessage } from '@/lib/session-state';
import { uploadFile } from '@/lib/uploads';
import { harnessOf, modelLabel } from '@/lib/harnesses';
import { pausedShort } from '@/lib/limits';
import { workingLabel } from '@/lib/settings';
import { cn } from '@/lib/utils';
import { StatusDot, TodoList } from './agent-bits';
import { useAgentPane } from './pane-state';

const DELIVER: Record<string, { label: string; title: string }> = {
  muster: { label: 'to muster', title: 'Its branch will be brought into the feature branch' },
  mustered: { label: 'mustered', title: 'Its work is in the feature branch' },
  standalone: { label: 'standalone', title: 'Its branch ships on its own; it is never merged' },
};

/** Muster: the agent that brings other agents' branches into the feature branch. */
function MusterChip({ className }: { className?: string }) {
  return (
    <span
      title="Muster brings other agents' branches into the feature branch"
      className={cn('bg-acc/15 text-acc inline-flex h-5 items-center rounded-full px-2 font-sans text-[11px] font-medium tracking-normal', className)}
    >
      Muster
    </span>
  );
}

/** A writer's own branch, and what becomes of it. */
function BranchLine({ agent: a }: { agent: AgentSummary }) {
  const state = a.worktree === 'mustered' ? DELIVER.mustered! : DELIVER[a.deliver ?? 'muster']!;
  return (
    <div className="text-mu2 flex min-w-0 items-center gap-1.5 text-xs">
      <GitBranchIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate font-mono" title={a.branch}>
        {a.branch}
      </span>
      <span title={state.title} className={cn('bg-chip shrink-0 rounded-full px-2 py-px text-[11px]', a.worktree === 'mustered' ? 'text-done' : 'text-mu')}>
        {state.label}
      </span>
    </div>
  );
}

const iconButton = 'text-mu2 hover:bg-hov hover:text-fg flex size-8 shrink-0 items-center justify-center rounded-full';

/** The right-hand card of an orchestrator round-up: all its agents, and a tab per agent opened. */
export function AgentPane({ agents }: { agents: AgentSummary[] }) {
  const pane = useAgentPane()!;
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const tabs = pane.tabs.filter((id) => byId.has(id));
  const active = pane.active ? byId.get(pane.active) : undefined;

  return (
    <section
      aria-label="Agent pane"
      className="bg-background shadow-card fixed inset-2 z-40 flex min-w-0 flex-col overflow-hidden rounded-3xl sm:left-auto sm:w-[30rem] lg:static lg:z-auto lg:w-auto lg:flex-[0_1_470px]"
    >
      <div role="tablist" aria-label="Open agents" className="flex items-center gap-1 overflow-x-auto px-2.5 pt-2.5">
        <button
          type="button"
          role="tab"
          aria-selected={!active}
          onClick={pane.showList}
          className={cn('flex h-[34px] shrink-0 items-center gap-[7px] rounded-full px-3 text-[13px]', active ? 'text-mu hover:text-fg' : 'bg-raise text-fg')}
        >
          <ListIcon className="size-3.5" />
          All
        </button>
        {tabs.map((id) => {
          const a = byId.get(id)!;
          const on = id === active?.id;
          return (
            <span key={id} className={cn('flex shrink-0 items-center rounded-full', on && 'bg-raise')}>
              <button
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => pane.openAgent(id)}
                className={cn('flex h-[34px] items-center gap-2 pr-1 pl-3 text-[13px] whitespace-nowrap', on ? 'text-fg' : 'text-mu hover:text-fg')}
              >
                <StatusDot status={a.status} />
                <span className="max-w-40 truncate">{a.title}</span>
              </button>
              <button
                type="button"
                onClick={() => pane.closeTab(id)}
                aria-label={`Close ${a.title}`}
                className="text-mu2 hover:text-fg mr-[5px] flex size-[22px] items-center justify-center rounded-full"
              >
                <XIcon className="size-[11px]" strokeWidth={2.4} />
              </button>
            </span>
          );
        })}
        <span className="flex-1" />
        <button type="button" onClick={pane.close} aria-label="Close pane" className={iconButton}>
          <XIcon className="size-[15px]" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{active ? <AgentView key={active.id} agent={active} /> : <AgentList agents={agents} />}</div>
    </section>
  );
}

const GROUP_LABEL: Record<AgentStatus, string> = { 'needs-approval': 'Needs you', failed: 'Failed', working: 'Working', halted: 'Stopped by you', paused: 'Paused for usage limit', stopped: 'Stopped', idle: 'Idle', done: 'Done' };
const FLEET: Record<AgentStatus, string> = { 'needs-approval': 'bg-wait', failed: 'bg-fail', working: 'bg-run', halted: 'bg-mu2', paused: 'bg-run/40', stopped: 'bg-ln2', idle: 'bg-ln2', done: 'bg-done' };
const PER_GROUP = 6;

/** Every agent: a filter, status chips, the fleet map (one square each), and the agents grouped by status. */
function AgentList({ agents }: { agents: AgentSummary[] }) {
  const pane = useAgentPane()!;
  const now = useNow(10_000);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<AgentStatus | 'all'>('all');
  const [collapsed, setCollapsed] = useState<Partial<Record<AgentStatus, boolean>>>({});
  const [showAll, setShowAll] = useState<Partial<Record<AgentStatus, boolean>>>({});
  const sorted = [...agents].sort(byAttention);
  const count = (s: AgentStatus) => agents.filter((a) => a.status === s).length;
  const query = q.trim().toLowerCase();
  const matches = (a: AgentSummary) => (filter === 'all' || a.status === filter) && (!query || a.title.toLowerCase().includes(query));
  const chips = [['all', 'All', agents.length] as const, ...STATUS_ORDER.map((s) => [s, GROUP_LABEL[s], count(s)] as const)].filter(
    ([key, , n]) => key === 'all' || n > 0,
  );
  const groups = STATUS_ORDER.map((status) => ({ status, rows: sorted.filter((a) => a.status === status && matches(a)) })).filter((g) => g.rows.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-4 pb-3">
      <label className="bg-chip flex h-10 shrink-0 items-center gap-2 rounded-full px-3.5">
        <SearchIcon className="text-mu2 size-3.5 shrink-0" />
        <span className="sr-only">Filter agents</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Filter ${agents.length} agent${agents.length === 1 ? '' : 's'}…`}
          className="text-fg min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
      </label>

      <div role="radiogroup" aria-label="Status filter" className="flex flex-wrap gap-1.5">
        {chips.map(([key, label, n]) => {
          const on = filter === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setFilter(key)}
              className={cn('flex h-[30px] items-center gap-1.5 rounded-full px-[11px] text-[13px]', on ? 'bg-fg text-background' : 'bg-chip text-fg2 hover:bg-raise')}
            >
              {label}
              <span className="font-mono text-[11px] opacity-75">{n}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="text-mu2 flex items-baseline justify-between text-xs">
          <span>Fleet</span>
          <span>
            {count('done')} of {agents.length} done
          </span>
        </div>
        <div role="group" aria-label="Fleet map, one square per agent" className="flex flex-wrap gap-[3px]">
          {sorted.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => pane.openAgent(a.id)}
              aria-label={`${a.title}: ${STATUS_LABEL[a.status]}`}
              title={`${a.title} — ${STATUS_LABEL[a.status]}`}
              className={cn('size-[11px] rounded-[3px]', FLEET[a.status], a.status === 'working' && 'motion-safe:animate-k-halo [--k-halo:var(--run)]', a.status === 'needs-approval' && 'motion-safe:animate-k-halo [--k-halo:var(--wait)]', !matches(a) && 'opacity-20')}
            />
          ))}
        </div>
      </div>

      <div className="-mx-1.5 flex flex-col gap-2.5">
        {agents.length === 0 && <p className="text-mu px-2.5 text-sm">No agents yet. They appear here as Kelpie starts them.</p>}
        {agents.length > 0 && groups.length === 0 && <p className="text-mu px-2.5 py-2 text-sm">No agents match.</p>}
        {groups.map(({ status, rows }) => {
          // Done agents start folded away when others are still moving; a search or a status
          // filter always shows what it found.
          const folded = collapsed[status] ?? (status === 'done' && groups.length > 1);
          const open = !folded || !!query || filter === status;
          const shown = showAll[status] ? rows : rows.slice(0, PER_GROUP);
          return (
            <div key={status} className="flex flex-col">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setCollapsed((c) => ({ ...c, [status]: open }))}
                className="text-mu hover:bg-hov flex h-8 items-center gap-2 rounded-lg px-2 text-left text-xs"
              >
                <ChevronRightIcon className={cn('size-[11px] transition-transform', open && 'rotate-90')} strokeWidth={2.6} />
                <StatusDot status={status} />
                {GROUP_LABEL[status]}
                <span className="text-mu2 font-mono text-[11px]">{rows.length}</span>
              </button>
              {open && (
                <div className="flex flex-col">
                  {shown.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => pane.openAgent(a.id)}
                      className="hover:bg-hov grid min-h-12 grid-cols-[18px_1fr_auto] items-center gap-3 rounded-xl px-2.5 py-1.5 text-left"
                    >
                      <HarnessMark harness={a.harness} />
                      <span className="flex min-w-0 flex-col">
                        <span className={cn('truncate text-sm', a.status === 'done' || a.status === 'idle' ? 'text-mu' : 'text-fg')}>
                          {a.kind === 'muster' && <MusterChip className="mr-1.5" />}
                          {a.title}
                        </span>
                        <span className="text-mu truncate text-xs">{a.limited ? `Usage limit · ${pausedShort(a.limited, now)}` : a.now || STATUS_LABEL[a.status]}</span>
                      </span>
                      <span className="text-mu2 text-xs">{a.status === 'working' ? elapsed(a, now) : STATUS_LABEL[a.status].toLowerCase()}</span>
                    </button>
                  ))}
                  {shown.length < rows.length && (
                    <button
                      type="button"
                      onClick={() => setShowAll((s) => ({ ...s, [status]: true }))}
                      className="text-mu hover:text-fg ml-10 h-8 self-start text-[13px]"
                    >
                      Show all {rows.length}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** An agent the person stopped ("Stop all"): it waits for them, and they can pick it up on its own. */
function HaltedBanner({ agentId }: { agentId: string }) {
  const { resume, pending, error } = useResumeAgent(agentId);
  return (
    <div className="bg-well flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] px-3.5 py-3 text-sm">
      <SquareIcon aria-hidden="true" className="fill-mu2 text-mu2 size-3.5 shrink-0" strokeWidth={2} />
      <span className="min-w-0 flex-1">
        Stopped by you. It keeps its work and waits until you resume it.
        {error && <span className="text-fail block text-xs">{error}</span>}
      </span>
      <Button variant="outline" size="sm" disabled={pending} onClick={resume} title="Continue where it left off, as the agent limit allows">
        <PlayIcon aria-hidden="true" className="text-run fill-current" />
        Resume
      </Button>
    </div>
  );
}

/** One agent: who and how it is, what it is doing right now, its todos, its timeline, and a line to it. */
function AgentView({ agent: a }: { agent: AgentSummary }) {
  const openSession = useOpenSession();
  const now = useNow(10_000);
  const [error, setError] = useState<string | undefined>();
  const log = useEventLog(a.id);
  // Messages sent from the pane show at once; the harness only echoes one when it takes it in.
  const [sent, setSent] = useState<SentMessage[]>([]);
  const pending = useMemo(() => unechoed(sent, log.events), [sent, log.events]);
  const done = a.todos.filter((t) => t.status === 'completed').length;
  // A writer with a branch has changes to look at; Muster's are the others' (the round-up's Changes tab).
  const reviewable = !!a.branch && a.kind !== 'muster';
  const [tab, setTab] = useState<'activity' | 'changes'>('activity');
  const files = useChanges(reviewable ? a.id : undefined, { patches: false, working: a.status === 'working' }).data;
  const tabs = reviewable ? (
    <TabStrip
      label="Agent views"
      tabs={[
        { id: 'activity', label: 'Activity' },
        { id: 'changes', label: 'Changes', ...(files?.state === 'ready' ? { count: files.stats.files } : {}) },
      ]}
      value={tab}
      onChange={setTab}
      className="flex-1"
    >
      {tab === 'activity' && <ShowCommandsToggle />}
    </TabStrip>
  ) : undefined;
  const pause = () => api('POST', `/api/sessions/${a.id}/interrupt`).catch((err) => setError((err as Error).message));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex max-h-[55%] shrink-0 flex-col gap-4 overflow-y-auto px-[22px] pt-5 pb-[18px]">
        <div className="flex items-start gap-3">
          <HarnessMark harness={a.harness} size="lg" className="mt-0.5" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="font-heading text-2xl leading-[1.1] font-semibold tracking-[-0.03em]">
              {a.title}
              {a.kind === 'muster' && <MusterChip className="ml-2 align-middle" />}
            </h2>
            <div className="text-mu flex flex-wrap items-center gap-[7px] text-[13px]">
              <StatusDot status={a.status} />
              {STATUS_LABEL[a.status]}
              <span className="text-fa">·</span>
              {[harnessOf(a.harness).name, a.model && modelLabel(a.model)].filter(Boolean).join(' ')}
              <span className="text-fa">·</span>
              {a.writes ? 'can edit' : 'read-only'}
              {a.browser && (
                <>
                  <span className="text-fa">·</span>
                  drives Chrome
                </>
              )}
              <span className="text-fa">·</span>
              {elapsed(a, now)}
            </div>
            {a.branch && <BranchLine agent={a} />}
          </div>
          <div className="flex gap-0.5">
            <button type="button" onClick={pause} disabled={a.status !== 'working' && a.status !== 'needs-approval'} aria-label="Pause agent" title="Pause" className={cn(iconButton, 'disabled:opacity-40')}>
              <PauseIcon className="size-3.5" strokeWidth={2.2} />
            </button>
            <button type="button" onClick={() => openSession(a.id)} aria-label="Open full session" title="Open full session" className={iconButton}>
              <ExternalLinkIcon className="size-3.5" strokeWidth={2.2} />
            </button>
          </div>
        </div>

        {a.status === 'halted' ? (
          <HaltedBanner agentId={a.id} />
        ) : a.status === 'paused' && a.limited ? (
          <PausedBanner sessionId={a.id} pause={a.limited} className="rounded-[14px]" />
        ) : (
          <div className="bg-well flex items-start gap-2.5 rounded-[14px] px-3.5 py-3">
            <StatusDot status={a.status} className="mt-[7px]" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-mu2 text-xs">Right now</span>
              <span className="text-[15px] leading-[1.45] break-words">{a.now || STATUS_LABEL[a.status]}</span>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <div className="text-mu2 flex items-center gap-2.5 text-xs">
            <span>Todos</span>
            <div className="bg-ln2 h-1 flex-1 overflow-hidden rounded-full">
              <div className="bg-done h-full rounded-full" style={{ width: `${a.todos.length ? (done / a.todos.length) * 100 : 0}%` }} />
            </div>
            <span className="font-mono text-[11px]">
              {done}/{a.todos.length}
            </span>
          </div>
          {a.todos.length === 0 ? <p className="text-mu text-[13px]">No todo list yet.</p> : <TodoList todos={a.todos} />}
        </div>
        {error && <p className="text-fail text-xs">{error}</p>}
      </div>

      <AgentApprovals agent={a} />
      {tab === 'changes' && reviewable ? (
        <section aria-label="Changes" className="border-ln flex min-h-0 flex-1 flex-col border-t">
          <div className="flex items-center px-[22px] pt-1.5">{tabs}</div>
          <AgentChanges agent={a} />
        </section>
      ) : (
        <AgentTimeline agent={a} events={log.events} error={log.error} pending={pending} tabs={tabs} />
      )}
      {tab === 'activity' && (
        <AgentMessage
          agent={a}
          onSend={(text, files) => {
            const attachments = files.map((f) => ({ name: f.name, size: f.size, mime: f.type }));
            const message = { id: Date.now() + Math.random(), text, after: log.events.length, ...(files.length ? { attachments } : {}) };
            setSent((s) => [...unechoed(s, log.events), message]);
            return () => setSent((s) => s.filter((m) => m !== message));
          }}
        />
      )}
    </div>
  );
}

/** What this agent is waiting on the person to allow, answered right here (the round-up's tray has it too; its questions are in its timeline). */
function AgentApprovals({ agent: a }: { agent: AgentSummary }) {
  const all = useApprovals(a.parentId);
  const groups = useMemo(() => groupApprovals(all.filter((x) => x.sessionId === a.id)), [all, a.id]);
  const { run, busy, error } = useGroupAnswers();
  const [selected, setSelected] = useState(0);
  if (!groups.length) return null;
  return (
    <section aria-label="Waiting on you" className="border-ln border-t px-3.5 py-2">
      <div className="text-wait px-1 pb-1 text-xs font-medium">Waiting on you</div>
      <ul className="group/approvals flex flex-col gap-0.5">
        {groups.map((g, i) => (
          <ApprovalRow key={g.key} group={g} selected={i === selected} busy={busy} onSelect={() => setSelected(i)} onAnswer={(ans) => void run([g], ans)} />
        ))}
      </ul>
      {error && <p className="text-fail px-1 pt-1 text-xs">{error}</p>}
    </section>
  );
}

/** What the agent did and what was said to it, as the design's activity and message bubbles. `tabs` replace its label. */
function AgentTimeline({
  agent: a,
  events,
  error,
  pending,
  tabs,
}: {
  agent: AgentSummary;
  events: KelpieEvent[];
  error: string | undefined;
  pending: SentMessage[];
  tabs?: ReactNode;
}) {
  const items = useMemo(() => buildChat(events), [events]);
  const end = useRef<HTMLDivElement>(null);
  // Follow the newest entry, as a tail would. A block body: scrollIntoView may return a promise,
  // and anything an effect returns is taken for its cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [items, pending.length]);
  const time = (ts?: string) => (ts ? format(new Date(ts), 'HH:mm') : '');

  return (
    <section aria-label="Activity and messages" className="border-ln flex min-h-0 flex-1 flex-col border-t">
      {tabs ? (
        <div className="flex items-center px-[22px] pt-1.5">{tabs}</div>
      ) : (
        <div className="flex items-center justify-between px-[22px] pt-3 pb-0.5">
          <span className="text-mu2 text-xs">Activity and messages</span>
          <ShowCommandsToggle />
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-[22px] pt-3 pb-4">
        {error && <p className="text-fail text-sm">{error}</p>}
        {events.length === 0 && !error && <p className="text-mu text-sm">Loading…</p>}
        {items.map((item) =>
          item.role === 'user' ? (
            <div key={item.id} className="flex flex-col items-end gap-1">
              <div className="text-mu2 text-xs">
                {item.source === 'orchestrator' ? 'Kelpie' : 'You'} · {time(item.ts)}
              </div>
              <AttachmentChips sessionId={a.id} attachments={item.attachments} className="max-w-[85%]" />
              {item.text && <div className="bg-raise max-w-[85%] rounded-2xl px-3.5 py-[9px] text-sm leading-[1.45] break-words whitespace-pre-wrap">{item.text}</div>}
            </div>
          ) : (
            item.parts.map((p, i) => {
              const key = `${item.id}-${i}`;
              switch (p.type) {
                case 'tool':
                  return <StepRow key={key} tool={p} />;
                case 'text':
                  return (
                    <div key={key} className="flex flex-col items-start gap-1">
                      <div className="text-mu2 text-xs">
                        {a.title} · {time(p.ts)}
                      </div>
                      <div className="bg-surf max-w-[92%] min-w-0 rounded-2xl px-3.5 py-[9px] text-sm leading-[1.45] shadow-[inset_0_0_0_1px_var(--ln2)] [&_h1]:text-[15px] [&_h2]:text-sm [&_h3]:text-sm [&_:is(h1,h2,h3)]:mt-3 [&_:is(h1,h2,h3)]:mb-1 [&_:is(h1,h2,h3)]:font-semibold [&>*>:first-child]:mt-0">
                        <MessageResponse>{p.text}</MessageResponse>
                      </div>
                    </div>
                  );
                case 'notice':
                  return (
                    <EventLine key={key} tone={p.tone === 'error' ? 'fail' : 'muted'}>
                      {p.text} · {time(p.ts)}
                    </EventLine>
                  );
                case 'reasoning':
                  return (
                    <p key={key} className="text-mu text-sm whitespace-pre-wrap italic">
                      {p.text}
                    </p>
                  );
                case 'question':
                  return <QuestionCard key={key} questions={p.questions} state={p.state} answers={p.answers} sessionId={a.id} requestId={p.requestId} />;
                case 'limit':
                  return <LimitLine key={key} limit={p.limit} message={p.message} ts={p.ts} />;
                case 'resumed':
                  return <ResumedLine key={key} ts={p.ts} />;
                case 'halt':
                  return <HaltLine key={key} action={p.action} text={p.text} ts={p.ts} />;
                default:
                  return null;
              }
            })
          ),
        )}
        {pending.map((m) => (
          <div key={m.id} className="flex flex-col items-end gap-1">
            <div className="text-mu2 text-xs">You · sending…</div>
            <AttachmentChips sessionId={undefined} attachments={m.attachments} className="max-w-[85%] opacity-70" />
            {m.text && <div className="bg-raise max-w-[85%] rounded-2xl px-3.5 py-[9px] text-sm leading-[1.45] break-words whitespace-pre-wrap opacity-70">{m.text}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
    </section>
  );
}

/**
 * A line straight to the agent; its orchestrator hears how it turns out when the agent next goes
 * idle. `onSend` shows the message at once and returns how to take it back if sending fails.
 */
function AgentMessage({ agent: a, onSend }: { agent: AgentSummary; onSend: (text: string, files: File[]) => () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();
  const attached = useAttachedFiles();
  const { getRootProps, getInputProps, isDragActive, open } = attached.dropzone;

  // Each message goes on its own: the next can be typed and sent while one is still on its way.
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const message = text.trim();
    const files = attached.files;
    if (!message && !files.length) return;
    setError(undefined);
    setText('');
    attached.setFiles([]);
    const undo = onSend(message, files);
    try {
      // Into the round-up's scratch folder, like the composer's files.
      const uploads = await Promise.all(files.map((f) => uploadFile(a.id, f)));
      await api('POST', `/api/sessions/${a.id}/messages`, { text: message, ...(uploads.length ? { attachments: uploads.map((u) => u.id) } : {}) });
    } catch (err) {
      undo();
      setText((now) => now || message);
      attached.setFiles((now) => (now.length ? now : files));
      setError((err as Error).message);
    }
  };

  return (
    <form onSubmit={send} {...getRootProps({ className: 'border-ln flex flex-col gap-1.5 border-t px-3.5 pt-2.5 pb-3.5' })}>
      <input {...getInputProps()} />
      <FileChips files={attached.files} onRemove={attached.remove} />
      <div className={cn('bg-chip flex items-center gap-1.5 rounded-full py-[5px] pr-[5px] pl-1.5', isDragActive && 'ring-acc/40 ring-2')}>
        <AttachButton onClick={open} />
        <label htmlFor="agent-message" className="sr-only">
          Message {a.title}
        </label>
        <input
          id="agent-message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={attached.onPaste}
          placeholder={isDragActive ? 'Drop files to attach them' : `Message ${a.title}…`}
          className="text-fg h-[34px] min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
        <button
          type="submit"
          aria-label="Send to this agent"
          disabled={!text.trim() && !attached.files.length}
          className="bg-acc text-accfg flex size-[34px] shrink-0 items-center justify-center rounded-full disabled:opacity-50"
        >
          <ArrowUpIcon className="size-3.5" strokeWidth={2.4} />
        </button>
      </div>
      <p className={cn('px-2 text-xs', error ? 'text-fail' : 'text-mu2')}>{error ?? `Goes straight to ${a.title}. Kelpie hears how it turns out.`}</p>
    </form>
  );
}

/** The header's agents button: who needs a look (failed), who is working (of the person's limit), and how many in all. */
export function AgentsButton() {
  const pane = useAgentPane();
  const limit = useMaxAgents();
  if (!pane || pane.agents.length === 0) return null;
  const listOn = pane.open && !pane.active;
  const failed = pane.agents.filter((a) => a.status === 'failed').length;
  const working = pane.agents.filter((a) => a.status === 'working' || a.status === 'needs-approval').length;
  const total = pane.agents.length;
  return (
    <button
      type="button"
      onClick={pane.toggleList}
      aria-pressed={listOn}
      className={cn('text-fg flex h-[34px] shrink-0 items-center gap-[9px] rounded-full pr-3.5 pl-3 text-[13px]', pane.open ? 'bg-raise' : 'bg-chip hover:bg-raise')}
    >
      {failed > 0 && (
        <span aria-label={`${failed} failed`} className="text-fail flex items-center gap-1.5 font-mono text-xs">
          <StatusDot status="failed" />
          {failed}
        </span>
      )}
      {working > 0 && (
        <span aria-label={workingLabel(working, limit)} title={workingLabel(working, limit)} className="text-fg2 flex items-center gap-1.5 font-mono text-xs">
          <StatusDot status="working" />
          {working}
          {limit && <span className="text-mu2 -ml-1">/{limit}</span>}
        </span>
      )}
      <span>
        {total} agent{total === 1 ? '' : 's'}
      </span>
    </button>
  );
}

/** The pane when it is open and there is something to show. */
export function AgentPaneSlot() {
  const pane = useAgentPane();
  return pane?.open ? <AgentPane agents={pane.agents} /> : null;
}
