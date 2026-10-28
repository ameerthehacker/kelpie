import { XCircleIcon } from 'lucide-react';
import type { SpawnView } from '@/lib/chat';
import { AgentChip, MAX_CHIPS, useOpenAgent } from '@/components/chat/agent-chips';
import { useAgentPane } from './pane-state';

/**
 * Agents the orchestrator started, as chips that open the agent in the pane, capped at a row's
 * worth (the rest are "+N more", the pane's list); refusals as a line each.
 */
export function AgentPills({ spawns }: { spawns: SpawnView[] }) {
  const pane = useAgentPane();
  const open = useOpenAgent();
  const started = spawns.filter((s) => s.state !== 'error');
  const refused = spawns.filter((s) => s.state === 'error');
  const more = started.length - MAX_CHIPS;
  return (
    <div className="flex flex-col gap-2">
      {started.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {started.slice(0, MAX_CHIPS).map((s) => {
            const agent = pane?.agents.find((a) => a.id === s.agentId);
            return <AgentChip key={s.callId} agent={agent} title={s.title} disabled={!s.agentId} onClick={() => s.agentId && open(s.agentId)} />;
          })}
          {more > 0 && (
            <button type="button" onClick={() => pane?.showList()} className="text-mu hover:text-fg px-1 text-[13px] underline-offset-2 hover:underline">
              +{more} more
            </button>
          )}
        </div>
      )}
      {refused.slice(0, MAX_CHIPS).map((s) => (
        <p key={s.callId} className="text-mu flex items-start gap-2 text-sm">
          <XCircleIcon className="text-fail mt-0.5 size-4 shrink-0" />
          <span>
            Couldn't start “{s.title}”{s.error ? `: ${s.error}` : '.'}
          </span>
        </p>
      ))}
      {refused.length > MAX_CHIPS && <p className="text-mu text-sm">…and {refused.length - MAX_CHIPS} more couldn't start.</p>}
    </div>
  );
}
