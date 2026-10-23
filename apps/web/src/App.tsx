import { MessageSquareIcon, PlusIcon } from 'lucide-react';
import { AssistantPartView } from '@/components/chat/assistant-part';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSession } from '@/hooks/use-session';

export function App() {
  const { session, items, status, busy, error, send, interrupt, reset } = useSession();
  const last = items.at(-1);
  // Show a working indicator unless the agent is visibly streaming text right now.
  const working = busy && (last?.role !== 'assistant' || last.parts.at(-1)?.type !== 'text');

  return (
    <TooltipProvider>
      <div className="bg-background text-foreground flex h-dvh flex-col">
        <header className="flex items-center gap-3 border-b px-4 py-2">
          <span className="font-semibold tracking-tight">kelpie</span>
          <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">{session?.cwd}</span>
          <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
            <PlusIcon /> New chat
          </Button>
        </header>

        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="mx-auto w-full max-w-3xl">
            {items.length === 0 ? (
              <ConversationEmptyState
                icon={<MessageSquareIcon className="size-10" />}
                title="What are we working on?"
                description="Messages go to a Claude Code session in the daemon's working directory."
              />
            ) : (
              items.map((item, i) => (
                <Message from={item.role} key={item.id}>
                  <MessageContent className={item.role === 'assistant' ? 'w-full' : undefined}>
                    {item.role === 'user'
                      ? <p className="whitespace-pre-wrap">{item.text}</p>
                      : item.parts.map((part, j) => (
                          <AssistantPartView key={j} part={part} streaming={busy && i === items.length - 1 && j === item.parts.length - 1} />
                        ))}
                  </MessageContent>
                </Message>
              ))
            )}
            {working && <Shimmer className="text-sm">Working…</Shimmer>}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="mx-auto w-full max-w-3xl px-4 pb-4">
          {error && <p className="text-destructive mb-2 text-sm">{error}</p>}
          <PromptInput onSubmit={({ text }) => (text.trim() ? send(text.trim()) : undefined)}>
            <PromptInputBody>
              <PromptInputTextarea placeholder="Ask Claude Code to do something…" />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                <span className="text-muted-foreground px-2 text-xs">Claude Code</span>
              </PromptInputTools>
              <PromptInputSubmit status={status} onStop={interrupt} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </TooltipProvider>
  );
}
