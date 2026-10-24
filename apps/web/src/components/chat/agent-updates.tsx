import { BotIcon, ChevronRightIcon, CircleCheckIcon, CircleSlashIcon, ExternalLinkIcon, XCircleIcon } from 'lucide-react';
import { Link } from 'react-router';
import { useAgentPane } from '@/components/agents/pane-state';
import { firstLine, type AgentUpdate } from '@kelpie/protocol';
import { MessageResponse } from '@/components/ai-elements/message';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { roundUpPath } from '@/lib/round-ups';
import { cn } from '@/lib/utils';

const STATUS: Record<string, { label: string; icon: typeof CircleCheckIcon; className: string }> = {
  completed: { label: 'finished', icon: CircleCheckIcon, className: 'text-green-600 dark:text-green-500' },
  failed: { label: 'failed', icon: XCircleIcon, className: 'text-destructive' },
  interrupted: { label: 'stopped', icon: CircleSlashIcon, className: 'text-muted-foreground' },
};
const OTHER = { label: 'idle', icon: CircleSlashIcon, className: 'text-muted-foreground' };

function AgentRow({ agent }: { agent: AgentUpdate }) {
  const pane = useAgentPane();
  // The pane can only show agents it has; any other opens on its own page.
  const inPane = pane?.agents.some((a) => a.id === agent.agentId);
  const report = agent.report ?? '';
  const preview = firstLine(report);
  const status = STATUS[agent.status] ?? OTHER;
  const Icon = status.icon;
  const files = agent.filesChanged ?? [];
  return (
    <Collapsible className="group/agent">
      <CollapsibleTrigger className="hover:bg-muted/50 flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors">
        <Icon aria-label={status.label} className={cn('size-4 shrink-0', status.className)} />
        <span className="shrink-0 font-medium">{agent.title}</span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate">
          {status.label}
          {agent.error ? `: ${agent.error}` : preview ? ` · ${preview}` : ''}
        </span>
        {files.length > 0 && (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {files.length} file{files.length === 1 ? '' : 's'}
          </span>
        )}
        <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0 transition group-data-[state=open]/agent:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 px-3 pt-1 pb-3">
        {agent.error && <p className="text-destructive text-sm whitespace-pre-wrap">{agent.error}</p>}
        {files.length > 0 && (
          <ul className="space-y-0.5 font-mono text-xs">
            {files.map((f) => (
              <li key={f.path} className="flex gap-2">
                <span className="min-w-0 flex-1 truncate">{f.path}</span>
                <span className="text-green-600 tabular-nums dark:text-green-500">+{f.added}</span>
                <span className="text-red-600 tabular-nums dark:text-red-500">−{f.removed}</span>
              </li>
            ))}
          </ul>
        )}
        {report ? (
          <div className="bg-muted/40 rounded-md p-3 text-sm">
            <MessageResponse>{report}</MessageResponse>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No report.</p>
        )}
        {pane && inPane ? (
          <button type="button" onClick={() => pane.openAgent(agent.agentId)} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs">
            Open in agent pane <ExternalLinkIcon className="size-3" />
          </button>
        ) : (
          <Link to={roundUpPath(agent.agentId)} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs">
            Open agent <ExternalLinkIcon className="size-3" />
          </Link>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Sub-agents Kelpie reported to the orchestrator: one row each, expanding to the agent's report. */
export function AgentUpdates({ agents }: { agents: AgentUpdate[] }) {
  return (
    <div className="not-prose my-1 overflow-hidden rounded-lg border">
      <div className="text-muted-foreground bg-muted/30 flex items-center gap-1.5 border-b px-3 py-1.5 text-[11px] font-medium tracking-wide uppercase">
        <BotIcon className="size-3.5" />
        {agents.length === 1 ? 'Agent update' : `${agents.length} agent updates`}
      </div>
      <div className="divide-y">
        {agents.map((a) => (
          <AgentRow key={a.agentId} agent={a} />
        ))}
      </div>
    </div>
  );
}
