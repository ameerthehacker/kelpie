import { format } from 'date-fns';
import { useMemo } from 'react';
import { AgentPills } from '@/components/agents/agent-pills';
import { useAgentPane } from '@/components/agents/pane-state';
import { MessageResponse } from '@/components/ai-elements/message';
import { AgentEvents, EventLine } from '@/components/chat/events';
import { StepGroup } from '@/components/chat/steps';
import type { AssistantPart, SpawnView, ToolView } from '@/lib/chat';

type Block = Exclude<AssistantPart, ToolView | SpawnView> | { type: 'tools'; tools: ToolView[] } | { type: 'spawns'; spawns: SpawnView[] };

/** Folds runs of consecutive tool calls into one list of steps, and of agents started into one row of pills. */
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

interface Props {
  parts: AssistantPart[];
  streaming: boolean;
  /** Who did the steps: "Kelpie" for an orchestrator, the agent's title on its own page. */
  actor: string;
}

/** An assistant reply: text, steps, agents started and reported on, and notices, in order. */
export function AssistantParts({ parts, streaming, actor }: Props) {
  const pane = useAgentPane();
  // Kelpie's tools name agents by id; steps say their titles.
  const nameOf = useMemo(() => {
    const titles = new Map(pane?.agents.map((a) => [a.id, a.title]));
    return (id: string) => titles.get(id);
  }, [pane?.agents]);
  const list = blocks(parts);
  return list.map((block, i) => <BlockView key={i} block={block} streaming={streaming && i === list.length - 1} actor={actor} nameOf={nameOf} />);
}

function BlockView({ block: part, streaming, actor, nameOf }: { block: Block; streaming: boolean; actor: string; nameOf: (id: string) => string | undefined }) {
  switch (part.type) {
    case 'text':
      return <MessageResponse isAnimating={streaming}>{part.text}</MessageResponse>;
    case 'reasoning':
      // Claude Code rarely shows its thinking; when it does, it reads as an aside.
      return <p className="text-mu text-sm whitespace-pre-wrap italic">{part.text}</p>;
    case 'tools':
      return <StepGroup tools={part.tools} actor={actor} nameOf={nameOf} />;
    case 'spawns':
      return <AgentPills spawns={part.spawns} />;
    case 'agents':
      return <AgentEvents agents={part.agents} ts={part.ts} />;
    case 'notice':
      return (
        <EventLine tone={part.tone === 'error' ? 'fail' : 'muted'}>
          <span className="whitespace-pre-wrap">{part.text}</span> · {format(new Date(part.ts), 'HH:mm')}
        </EventLine>
      );
  }
}
