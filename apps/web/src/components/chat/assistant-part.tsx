import { CheckIcon, CircleIcon, InfoIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react';
import { MessageResponse } from '@/components/ai-elements/message';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import type { AssistantPart, ToolView } from '@/lib/chat';
import { cn } from '@/lib/utils';

const TOOL_STATE = { running: 'input-available', done: 'output-available', error: 'output-error' } as const;

const clip = (s: string, max = 90) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function ToolPart({ part }: { part: ToolView }) {
  const delta = part.delta ? ` +${part.delta.added} −${part.delta.removed}` : '';
  return (
    <Tool>
      <ToolHeader type="dynamic-tool" toolName={part.name} state={TOOL_STATE[part.state]} title={`${part.name} · ${clip(part.title)}${delta}`} />
      <ToolContent>
        <ToolInput input={part.input} />
        {part.steps.length > 0 && (
          <div className="space-y-1">
            <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Sub-agent steps</h4>
            <ul className="text-muted-foreground font-mono text-xs">
              {part.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        <ToolOutput
          output={part.state === 'done' && part.output ? <pre className="whitespace-pre-wrap p-3 font-mono">{part.output}</pre> : undefined}
          errorText={part.state === 'error' ? (part.output ?? 'Failed') : undefined}
        />
      </ToolContent>
    </Tool>
  );
}

const TODO_ICON = {
  completed: <CheckIcon className="size-3.5 text-green-600" />,
  in_progress: <LoaderCircleIcon className="size-3.5 animate-spin" />,
  pending: <CircleIcon className="text-muted-foreground size-3.5" />,
};

export function AssistantPartView({ part, streaming }: { part: AssistantPart; streaming: boolean }) {
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
    case 'tool':
      return <ToolPart part={part} />;
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
