import { InfoIcon, TriangleAlertIcon } from 'lucide-react';
import { AgentPills } from '@/components/agents/agent-pills';
import { MessageResponse } from '@/components/ai-elements/message';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { AgentUpdates } from '@/components/chat/agent-updates';
import { ToolGroup } from '@/components/chat/tool-group';
import type { AssistantPart, SpawnView, ToolView } from '@/lib/chat';
import { cn } from '@/lib/utils';

type Block = Exclude<AssistantPart, ToolView | SpawnView> | { type: 'tools'; tools: ToolView[] } | { type: 'spawns'; spawns: SpawnView[] };

/** Folds runs of consecutive tool calls into one log, and of agents started into one row of pills. */
function blocks(parts: AssistantPart[]): Block[] {
  const out: Block[] = [];
  for (const part of parts) {
    const last = out.at(-1);
    if (part.type === 'tool') {
      if (last?.type === 'tools') last.tools.push(part);
      else out.push({ type: 'tools', tools: [part] });
    } else if (part.type === 'spawn') {
      if (last?.type === 'spawns') last.spawns.push(part);
      else out.push({ type: 'spawns', spawns: [part] });
    } else out.push(part);
  }
  return out;
}

/** An assistant reply: text, reasoning, tool logs, agents started and reported on, and notices, in order. */
export function AssistantParts({ parts, streaming }: { parts: AssistantPart[]; streaming: boolean }) {
  const list = blocks(parts);
  return list.map((block, i) => <BlockView key={i} block={block} streaming={streaming && i === list.length - 1} />);
}

function BlockView({ block: part, streaming }: { block: Block; streaming: boolean }) {
  switch (part.type) {
    case 'text':
      return <MessageResponse isAnimating={streaming}>{part.text}</MessageResponse>;
    case 'reasoning':
      return (
        <Reasoning isStreaming={streaming}>
          <ReasoningTrigger />
          <ReasoningContent>{part.text}</ReasoningContent>
        </Reasoning>
      );
    case 'tools':
      return <ToolGroup tools={part.tools} />;
    case 'spawns':
      return <AgentPills spawns={part.spawns} />;
    case 'agents':
      return <AgentUpdates agents={part.agents} />;
    case 'notice':
      return (
        <div className={cn('flex items-start gap-2 text-sm', part.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
          {part.tone === 'error' ? <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" /> : <InfoIcon className="mt-0.5 size-4 shrink-0" />}
          <span className="whitespace-pre-wrap">{part.text}</span>
        </div>
      );
  }
}
