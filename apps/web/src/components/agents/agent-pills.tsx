import { XCircleIcon } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { SpawnView } from '@/lib/chat';
import { roundUpPath } from '@/lib/round-ups';
import { cn } from '@/lib/utils';
import { HarnessMark } from '@/components/harness-mark';
import { StatusDot } from './agent-bits';
import { useAgentPane } from './pane-state';

/** Agents the orchestrator started, as pills that open the agent's tab; refusals as a line each. */
export function AgentPills({ spawns }: { spawns: SpawnView[] }) {
  const pane = useAgentPane();
  const navigate = useNavigate();
  const started = spawns.filter((s) => s.state !== 'error');
  const refused = spawns.filter((s) => s.state === 'error');
  return (
    <div className="flex flex-col gap-2">
      {started.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {started.map((s) => {
            const agent = pane?.agents.find((a) => a.id === s.agentId);
            const focused = pane?.open && pane.active === s.agentId;
            return (
              <button
                key={s.callId}
                type="button"
                disabled={!s.agentId}
                aria-pressed={focused}
                // The pane shows only agents it has loaded; any other opens on its own page.
                onClick={() => (agent && pane ? pane.openAgent(agent.id) : s.agentId && navigate(roundUpPath(s.agentId)))}
                className={cn(
                  'hover:border-foreground/40 flex h-[30px] items-center gap-1.5 rounded-full border pr-2.5 pl-1.5 text-[13px] transition-colors disabled:opacity-60',
                  focused ? 'border-foreground bg-muted' : 'text-foreground/85',
                )}
              >
                <HarnessMark harness={agent?.harness ?? 'claude-code'} />
                {agent?.title ?? s.title}
                <StatusDot status={agent?.status ?? 'working'} />
              </button>
            );
          })}
        </div>
      )}
      {refused.map((s) => (
        <p key={s.callId} className="text-muted-foreground flex items-start gap-2 text-sm">
          <XCircleIcon className="text-destructive mt-0.5 size-4 shrink-0" />
          <span>
            Couldn't start “{s.title}”{s.error ? `: ${s.error}` : '.'}
          </span>
        </p>
      ))}
    </div>
  );
}
