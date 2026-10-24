import { format } from 'date-fns';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { firstLine, type AgentUpdate } from '@kelpie/protocol';
import { useAgentPane } from '@/components/agents/pane-state';
import { roundUpPath } from '@/lib/round-ups';
import { cn } from '@/lib/utils';

export type EventTone = 'done' | 'fail' | 'muted';

const DOT: Record<EventTone, string> = { done: 'bg-done', fail: 'bg-fail', muted: 'bg-mu2' };

/** The design's one-line event: a small dot, then what happened. A button when it leads somewhere. */
export function EventLine({ tone, children, onClick, title }: { tone: EventTone; children: ReactNode; onClick?: () => void; title?: string }) {
  const body = (
    <>
      <span aria-hidden="true" className={cn('mt-2 size-1.5 shrink-0 rounded-full', DOT[tone])} />
      <span className="min-w-0">{children}</span>
    </>
  );
  const cls = 'text-mu2 flex items-start gap-2.5 text-left text-[13px]';
  return onClick ? (
    <button type="button" onClick={onClick} title={title} className={cn(cls, 'hover:text-fg')}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

const SAID: Record<string, { verb: string; tone: EventTone }> = {
  completed: { verb: 'finished', tone: 'done' },
  failed: { verb: 'failed', tone: 'fail' },
  interrupted: { verb: 'stopped', tone: 'muted' },
};

/** Agents Kelpie reported to the orchestrator: one event line each, opening the agent. */
export function AgentEvents({ agents, ts }: { agents: AgentUpdate[]; ts: string }) {
  const pane = useAgentPane();
  const navigate = useNavigate();
  const time = format(new Date(ts), 'HH:mm');
  return (
    <div className="flex flex-col gap-2">
      {agents.map((a) => {
        const said = SAID[a.status] ?? { verb: 'is idle', tone: 'muted' as const };
        const detail = a.error ? firstLine(a.error, 90) : firstLine(a.report ?? '', 90);
        // The pane shows only agents it has loaded; any other opens on its own page.
        const inPane = pane?.agents.some((x) => x.id === a.agentId);
        return (
          <EventLine
            key={a.agentId}
            tone={said.tone}
            title={`Open ${a.title}`}
            onClick={() => (pane && inPane ? pane.openAgent(a.agentId) : navigate(roundUpPath(a.agentId)))}
          >
            {a.title} {said.verb}
            {detail && ` · ${detail}`} · {time}
          </EventLine>
        );
      })}
    </div>
  );
}
