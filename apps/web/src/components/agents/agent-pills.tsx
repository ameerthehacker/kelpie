import { XCircleIcon } from 'lucide-react';
import type { SpawnView } from '@/lib/chat';
import { cn } from '@/lib/utils';
import { HarnessMark } from '@/components/harness-mark';
import { useOpenSession } from '@/hooks/use-open-session';
import { StatusDot } from './agent-bits';
import { useAgentPane } from './pane-state';

/** Agents the orchestrator started, as pills that open the agent's tab; refusals as a line each. */
export function AgentPills({ spawns }: { spawns: SpawnView[] }) {
  const pane = useAgentPane();
  const openSession = useOpenSession();
  const started = spawns.filter((s) => s.state !== 'error');
  const refused = spawns.filter((s) => s.state === 'error');
  return (
    <div className="flex flex-col gap-2">
      {started.length > 0 && (
        <div className="flex flex-wrap gap-2">
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
                onClick={() => (agent && pane ? pane.openAgent(agent.id) : s.agentId && openSession(s.agentId))}
                className={cn(
                  'bg-chip hover:bg-raise flex h-[34px] items-center gap-2 rounded-full pr-3 pl-2 text-[13px] transition-colors disabled:opacity-60',
                  focused ? 'text-fg shadow-[inset_0_0_0_1.5px_var(--acc)]' : 'text-fg2',
                  !focused && agent?.status === 'failed' && 'shadow-[inset_0_0_0_1px_var(--fail)]',
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
        <p key={s.callId} className="text-mu flex items-start gap-2 text-sm">
          <XCircleIcon className="text-fail mt-0.5 size-4 shrink-0" />
          <span>
            Couldn't start “{s.title}”{s.error ? `: ${s.error}` : '.'}
          </span>
        </p>
      ))}
    </div>
  );
}
