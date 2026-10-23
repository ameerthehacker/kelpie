import { useCallback, useEffect, useRef, type CSSProperties } from 'react';
import { useMatch, useNavigate } from 'react-router';
import { AssistantParts } from '@/components/chat/assistant-part';
import { KelpieMark, RoundUpSidebar } from '@/components/chat/round-up-sidebar';
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
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useRoundUps } from '@/hooks/use-round-ups';
import { useSession, type ChatStatus } from '@/hooks/use-session';
import { ROUND_UP_ROUTE, roundUpPath, shortPath, titleOf } from '@/lib/round-ups';

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
  const roundUpId = useMatch(ROUND_UP_ROUTE)?.params.roundUpId;
  const navigate = useNavigate();
  const { roundUps, error: listError, defaultCwd, rename, remove, actionError, clearActionError } = useRoundUps();
  const onCreated = useCallback((id: string) => navigate(roundUpPath(id), { replace: true }), [navigate]);
  const { items, status, busy, error, send, interrupt } = useSession(roundUpId, onCreated);
  const current = roundUps?.find((r) => r.id === roundUpId);
  const cwd = current?.cwd ?? (roundUpId ? undefined : defaultCwd);
  const last = items.at(-1);
  // Show a working indicator unless the agent is visibly streaming text right now.
  const working = busy && (last?.role !== 'assistant' || last.parts.at(-1)?.type !== 'text');

  useEffect(() => {
    document.title = roundUpId ? `${titleOf(current)} · kelpie` : 'kelpie';
  }, [roundUpId, current]);

  return (
    <TooltipProvider>
      <SidebarProvider style={{ '--sidebar-width': '15.5rem' } as CSSProperties}>
        <RoundUpSidebar
          roundUps={roundUps}
          currentId={roundUpId}
          onNavigate={clearActionError}
          // Failures show through actionError; the sidebar has already put things back as they were.
          onRename={(id, title) => rename(id, title).catch(() => {})}
          onDelete={(id) =>
            remove(id).then(
              () => id === roundUpId && navigate('/', { replace: true }),
              () => {},
            )
          }
        />
        <SidebarInset className="h-dvh min-w-0">
          <header className="flex items-center gap-2.5 px-4 py-3">
            <SidebarTrigger className="text-muted-foreground" />
            <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
              <span className="truncate text-sm">{titleOf(current)}</span>
              {cwd && <span className="text-muted-foreground truncate font-mono text-xs">{shortPath(cwd)}</span>}
            </div>
          </header>

          <Conversation key={roundUpId ?? 'new'} className="min-h-0 flex-1">
            <ConversationContent className="mx-auto w-full max-w-3xl">
              {items.length === 0 ? (
                <ConversationEmptyState
                  icon={<KelpieMark className="size-10" />}
                  title="What are we working on?"
                  description={cwd ? `Claude Code works in ${shortPath(cwd)}.` : undefined}
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
            {(actionError ?? error ?? listError) && <p className="text-destructive mb-2 text-sm">{actionError ?? error ?? listError}</p>}
            <PromptInputProvider>
              <Composer status={status} send={send} interrupt={interrupt} />
            </PromptInputProvider>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
