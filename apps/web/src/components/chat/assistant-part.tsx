import { CheckIcon, CircleIcon, InfoIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react';
import { MessageResponse } from '@/components/ai-elements/message';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { ToolGroup } from '@/components/chat/tool-group';
import type { AssistantPart, ToolView } from '@/lib/chat';
import { cn } from '@/lib/utils';

const TODO_ICON = {
  completed: <CheckIcon className="size-3.5 text-green-600" />,
  in_progress: <LoaderCircleIcon className="size-3.5 animate-spin" />,
  pending: <CircleIcon className="text-muted-foreground size-3.5" />,
};

type Block = Exclude<AssistantPart, ToolView> | { type: 'tools'; tools: ToolView[] };

/** Folds runs of consecutive tool calls into one block, so they render as a single log. */
function blocks(parts: AssistantPart[]): Block[] {
  const out: Block[] = [];
  for (const part of parts) {
    const last = out.at(-1);
    if (part.type !== 'tool') out.push(part);
    else if (last?.type === 'tools') last.tools.push(part);
    else out.push({ type: 'tools', tools: [part] });
  }
  return out;
}

/** An assistant reply: text, reasoning, tool logs, todos and notices, in order. */
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
    case 'todos':
      return (
        <ul className="space-y-1 rounded-md border p-3 text-sm">
          {part.items.map((t) => (
            <li key={t.id} className={cn('flex items-center gap-2', t.status === 'completed' && 'text-muted-foreground line-through')}>
              {TODO_ICON[t.status]}
              {t.status === 'in_progress' ? (t.activeText ?? t.text) : t.text}
            </li>
          ))}
        </ul>
      );
    case 'notice':
      return (
        <div className={cn('flex items-start gap-2 text-sm', part.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
          {part.tone === 'error' ? <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" /> : <InfoIcon className="mt-0.5 size-4 shrink-0" />}
          <span className="whitespace-pre-wrap">{part.text}</span>
        </div>
      );
  }
}
