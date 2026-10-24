import { useCallback, useEffect, useRef, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useMatch, useNavigate } from 'react-router';
import { AgentPaneSlot, AgentsButton } from '@/components/agents/agent-pane';
import { AgentPaneProvider } from '@/components/agents/pane-state';
import { PlanDock, TodoDock } from '@/components/agents/plan-dock';
import { AssistantParts } from '@/components/chat/assistant-part';
import { ClaudeLogo } from '@/components/claude-logo';
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
import { LimitHint } from '@/components/chat/limit-hint';
import { useAgents } from '@/hooks/use-agents';
import { useRoundUps } from '@/hooks/use-round-ups';
import { useSession, type ChatStatus } from '@/hooks/use-session';
import type { AgentSummary } from '@/lib/agents';
import { api } from '@/lib/api';
import { ROUND_UP_ROUTE, roundUpPath, shortPath, titleOf, type RoundUp } from '@/lib/round-ups';

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
          <span className="text-muted-foreground flex items-center gap-1.5 px-2 text-xs">
            <ClaudeLogo label="" className="size-3.5" />
            Claude Code
          </span>
        </PromptInputTools>
        <PromptInputSubmit status={status} onStop={interrupt} />
      </PromptInputFooter>
    </PromptInput>
  );
}

const NO_AGENTS: AgentSummary[] = [];

export function App() {
  const roundUpId = useMatch(ROUND_UP_ROUTE)?.params.roundUpId;
  const navigate = useNavigate();
  const { roundUps, error: listError, defaultCwd, rename, remove, actionError, clearActionError } = useRoundUps();
  const onCreated = useCallback((id: string) => navigate(roundUpPath(id), { replace: true }), [navigate]);
  const { items, todos, status, busy, error, send, interrupt } = useSession(roundUpId, onCreated);
  // Sub-agents are not in the sidebar list; fetch one directly when it is opened.
  const listed = roundUps?.find((r) => r.id === roundUpId);
  const direct = useQuery({
    queryKey: ['round-up', roundUpId],
    queryFn: () => api<RoundUp>('GET', `/api/sessions/${roundUpId}`),
    enabled: !!roundUpId && !!roundUps && !listed,
  });
  const current = listed ?? (direct.data?.id === roundUpId ? direct.data : undefined);
  const cwd = current?.cwd ?? (roundUpId ? undefined : defaultCwd);
  // An orchestrator's agents; a sub-agent's own page has none. Wait for the role: a sub-agent
  // opened directly is not known to be one until its own fetch answers.
  const agents = useAgents(current?.role === 'orchestrator' ? roundUpId : undefined);
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
        {/* Keyed: each round-up opens with its pane closed and no tabs. */}
        <AgentPaneProvider key={roundUpId ?? 'new'} agents={agents ?? NO_AGENTS}>
          <SidebarInset className="h-dvh min-w-0 flex-row">
            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex items-center gap-2.5 px-4 py-3">
                <SidebarTrigger className="text-muted-foreground" />
                <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
                  <span className="truncate text-sm">{titleOf(current)}</span>
                  {cwd && <span className="text-muted-foreground truncate font-mono text-xs">{shortPath(cwd)}</span>}
                </div>
                <AgentsButton />
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
                {/* The plan sits outside the chat flow, always in view while agents work. */}
                {agents?.length ? <PlanDock /> : <TodoDock todos={todos} />}
                {(actionError ?? error ?? listError) && <p className="text-destructive mb-2 text-sm">{actionError ?? error ?? listError}</p>}
                <PromptInputProvider>
                  <Composer status={status} send={send} interrupt={interrupt} />
                </PromptInputProvider>
                {/* Every round-up runs on Claude Code for now. */}
                <LimitHint harness="claude-code" />
              </div>
            </div>
            <AgentPaneSlot />
          </SidebarInset>
        </AgentPaneProvider>
      </SidebarProvider>
    </TooltipProvider>
  );
}
