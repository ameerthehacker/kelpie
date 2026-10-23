import { MessageSquareIcon, PlusIcon } from 'lucide-react';
import { useRef } from 'react';
import { AssistantParts } from '@/components/chat/assistant-part';
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
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
} from '@/components/ai-elements/prompt-input';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSession, type ChatStatus } from '@/hooks/use-session';

interface ComposerProps {
  status: ChatStatus;
  send: (text: string) => Promise<void>;
  interrupt: () => void;
}

/** Clears as soon as a message is sent, and puts the text back if sending fails and the box is still empty. */
function Composer({ status, send, interrupt }: ComposerProps) {
  const { textInput } = usePromptInputController();
  const current = useRef(textInput.value);
  current.current = textInput.value;

  return (
    <PromptInput
      onSubmit={({ text }) => {
        const message = text.trim();
        if (!message) return;
        textInput.clear();
        send(message).catch(() => {
          if (!current.current) textInput.setInput(text);
        });
      }}
    >
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
  );
}

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
                <Message from={item.role} key={item.id} className={item.role === 'assistant' ? 'max-w-full' : undefined}>
                  <MessageContent className={item.role === 'assistant' ? 'w-full' : undefined}>
                    {item.role === 'user'
                      ? <p className="whitespace-pre-wrap">{item.text}</p>
                      : <AssistantParts parts={item.parts} streaming={busy && i === items.length - 1} />}
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
          <PromptInputProvider>
            <Composer status={status} send={send} interrupt={interrupt} />
          </PromptInputProvider>
        </div>
      </div>
    </TooltipProvider>
  );
}
