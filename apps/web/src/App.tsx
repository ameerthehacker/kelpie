import { PanelLeftIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Mode } from '@kelpie/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMatch, useNavigate } from 'react-router';
import { AgentPaneSlot, AgentsButton } from '@/components/agents/agent-pane';
import { AgentPaneProvider } from '@/components/agents/pane-state';
import { PlanDock, TodoDock } from '@/components/agents/plan-dock';
import { ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { AssistantParts } from '@/components/chat/assistant-part';
import { ApprovalTray } from '@/components/approvals/approval-tray';
import { ApprovalsPage } from '@/components/approvals/approvals-page';
import { ChangesTab } from '@/components/changes/changes-tab';
import { FullScreen } from '@/components/changes/full-screen';
import { TabStrip } from '@/components/changes/tab-strip';
import { AttachmentChips } from '@/components/chat/attachments';
import { ChatLog } from '@/components/chat/chat-log';
import { Composer } from '@/components/chat/composer';
import { HarnessSetupDialog } from '@/components/settings/setup-dialog';
import { SettingsPage } from '@/components/settings/settings-page';
import { WorkingStatus } from '@/components/chat/working-status';
import { AgentCrumb } from '@/components/shell/agent-crumb';
import { KelpieLogo } from '@/components/shell/brand';
import { Search } from '@/components/shell/search';
import { TicketChips } from '@/components/shell/tickets';
import { AppSidebar } from '@/components/shell/sidebar';
import { WorkbenchPage } from '@/components/workbench/workbench-page';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAgents } from '@/hooks/use-agents';
import { useApprovals } from '@/hooks/use-approvals';
import { useAttention } from '@/hooks/use-attention';
import { useBranches } from '@/hooks/use-branches';
import { useChanges } from '@/hooks/use-changes';
import { useChangesNav, type RoundUpTab } from '@/hooks/use-changes-nav';
import { useHarnesses } from '@/hooks/use-harnesses';
import { useIsMobile } from '@/hooks/use-mobile';
import { useNow } from '@/hooks/use-now';
import { useRoundUps } from '@/hooks/use-round-ups';
import { useSession } from '@/hooks/use-session';
import type { AgentSummary } from '@/lib/agents';
import { api } from '@/lib/api';
import { isRequestKind } from '@/lib/attention';
import { ROUND_UP_ROUTE, roundUpPath, roundUpSummary, shortPath, titleOf, type RoundUp } from '@/lib/round-ups';
import { WORKBENCH_ROUTE } from '@/lib/workbench';

const NO_AGENTS: AgentSummary[] = [];
const NAV_KEY = 'kelpie.nav';

/** Whether the sidebar is shown on a wide screen, remembered per browser. */
function useNavOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(NAV_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const set = useCallback((next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(NAV_KEY, next ? '1' : '0');
    } catch {}
  }, []);
  return [open, set];
}

/** The round-up's name in the display face, with its repo, what it is up to, and its tickets. */
function TitleBlock({ roundUp, agents }: { roundUp: RoundUp; agents: AgentSummary[] }) {
  const now = useNow();
  return (
    <div className="flex flex-col gap-2.5 pb-2">
      <h1 className="font-heading text-[42px] leading-[1.05] font-semibold tracking-[-0.035em] text-balance max-sm:text-[32px]">{titleOf(roundUp)}</h1>
      <div className="text-mu flex flex-wrap items-center gap-2.5 text-[13px]">
        <span className="font-mono text-xs">{shortPath(roundUp.cwd)}</span>
        {roundUp.baseBranch && (
          <span title={roundUp.baseCommit ? `at ${roundUp.baseCommit.slice(0, 10)}` : undefined} className="text-mu font-mono text-xs">
            from {roundUp.baseBranch}
          </span>
        )}
        <span aria-hidden="true" className="text-fa">
          ·
        </span>
        <span>{roundUpSummary(roundUp, agents, now)}</span>
        {!!roundUp.tickets?.length && (
          <>
            <span aria-hidden="true" className="text-fa">
              ·
            </span>
            <TicketChips tickets={roundUp.tickets} />
          </>
        )}
      </div>
    </div>
  );
}

/** An orchestrator round-up's two views: the conversation, and the feature branch's changes under review. */
function RoundUpTabs({ roundUpId, value, onChange }: { roundUpId: string; value: RoundUpTab; onChange: (tab: RoundUpTab) => void }) {
  const files = useChanges(roundUpId, { patches: false }).data;
  return (
    <TabStrip
      label="Round-up views"
      tabs={[
        { id: 'conversation', label: 'Conversation' },
        { id: 'changes', label: 'Changes', ...(files?.state === 'ready' ? { count: files.stats.files } : {}) },
      ]}
      value={value}
      onChange={onChange}
      className="-mt-3"
    />
  );
}

function EmptyState({ cwd }: { cwd: string | undefined }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 pt-[18vh] pb-10 text-center">
      <KelpieLogo className="size-16" />
      <h1 className="font-heading text-[40px] leading-[1.1] font-semibold tracking-[-0.035em] max-sm:text-3xl">What are we rounding up?</h1>
      <p className="text-mu text-[15px]">
        Describe the outcome. Kelpie plans the work and herds the agents{cwd ? ` in ${shortPath(cwd)}` : ''}.
      </p>
    </div>
  );
}

export function App() {
  const roundUpId = useMatch(ROUND_UP_ROUTE)?.params.roundUpId;
  const onApprovals = !!useMatch('/approvals');
  const linkedCard = useMatch(WORKBENCH_ROUTE)?.params.cardId;
  const onWorkbench = !!useMatch('/workbench') || !!linkedCard;
  const onSettings = !!useMatch('/settings');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const [navOpen, setNavOpen] = useNavOpen();
  const [mobileNav, setMobileNav] = useState(false);
  const [draftModel, setDraftModel] = useState('');
  const [draftBase, setDraftBase] = useState('');
  const [draftMode, setDraftMode] = useState<Mode>('auto');
  const [modelError, setModelError] = useState<string | undefined>();
  const { roundUps, error: listError, defaultCwd, rename, remove, actionError, clearActionError } = useRoundUps();
  const onCreated = useCallback((id: string) => navigate(roundUpPath(id), { replace: true }), [navigate]);
  const { events, items, todos, status, busy, error, send, interrupt } = useSession(roundUpId, onCreated, {
    model: draftModel || undefined,
    baseBranch: draftBase || undefined,
    mode: draftMode,
  });
  const modes = useHarnesses()?.find((h) => h.harness === 'claude-code')?.modes ?? [];
  // Sub-agents are not in the sidebar list; fetch one directly when it is opened.
  const listed = roundUps?.find((r) => r.id === roundUpId);
  const direct = useQuery({
    queryKey: ['round-up', roundUpId],
    queryFn: () => api<RoundUp>('GET', `/api/sessions/${roundUpId}`),
    enabled: !!roundUpId && !!roundUps && !listed,
  });
  const current = listed ?? (direct.data?.id === roundUpId ? direct.data : undefined);
  // On a sub-agent's own page, only what that agent is asking.
  const roundUpApprovals = useApprovals(current?.role === 'agent' ? current.parentId : roundUpId);
  const approvals = useMemo(() => (current?.role === 'agent' ? roundUpApprovals.filter((a) => a.sessionId === roundUpId) : roundUpApprovals), [roundUpApprovals, current?.role, roundUpId]);
  const cwd = current?.cwd ?? (roundUpId ? undefined : defaultCwd);
  // An orchestrator's agents; a sub-agent's own page has none. Wait for the role: a sub-agent
  // opened directly is not known to be one until its own fetch answers.
  const agents = useAgents(current?.role === 'orchestrator' ? roundUpId : undefined);
  const last = items.at(-1);
  // Steps on a sub-agent's own page are its own; everywhere else they are Kelpie's.
  const actor = current?.role === 'agent' ? titleOf(current) : 'Kelpie';
  const model = roundUpId ? (current?.model ?? '') : draftModel;
  const branches = useBranches(current?.role === 'agent' ? undefined : cwd);
  const base = roundUpId ? (current?.baseBranch ?? '') : draftBase;
  const mode = roundUpId ? (current?.mode ?? 'auto') : draftMode;
  // Once a writer has a branch of its own, it started from the base: that can't change any more.
  const baseLocked = !!agents?.some((a) => a.branch);
  // The tab's title counts what is waiting on the person: every open approval, and what they were
  // notified of while away (cleared as they come back).
  const unseen = useAttention();
  const allApprovals = useApprovals();
  const nav = useChangesNav();
  // The Changes tab (and full screen) are an orchestrator's: its feature branch, under review.
  const reviewable = !!roundUpId && current?.role === 'orchestrator';
  const onChanges = reviewable && nav.tab === 'changes';
  const tabs = reviewable && <RoundUpTabs roundUpId={roundUpId} value={nav.tab} onChange={nav.setTab} />;
  const waiting = allApprovals.length + unseen.filter((i) => !isRequestKind(i.kind)).length;

  useEffect(() => {
    const title = roundUpId ? `${titleOf(current)} · kelpie` : onWorkbench ? 'Workbench · kelpie' : 'kelpie';
    document.title = waiting ? `(${waiting}) ${title}` : title;
  }, [roundUpId, current, waiting, onWorkbench]);
  useEffect(() => setModelError(undefined), [roundUpId]);

  const changeModel = (next: string) => {
    if (!roundUpId) return setDraftModel(next);
    setModelError(undefined);
    // The daemon's session event updates the list; a sub-agent opened directly is refetched.
    api<RoundUp>('PATCH', `/api/sessions/${roundUpId}`, { model: next || null }).then(
      () => queryClient.invalidateQueries({ queryKey: ['round-up', roundUpId] }),
      (err: Error) => setModelError(`Couldn't change the model: ${err.message}`),
    );
  };
  const changeMode = (next: Mode) => {
    if (!roundUpId) return setDraftMode(next);
    setModelError(undefined);
    // Optimistic: Shift+Tab should feel instant. The daemon's session event confirms it (or the refetch puts it back).
    queryClient.setQueryData<RoundUp[]>(['round-ups'], (list) => list?.map((r) => (r.id === roundUpId ? { ...r, mode: next } : r)));
    api<RoundUp>('PATCH', `/api/sessions/${roundUpId}`, { mode: next }).catch((err: Error) => {
      setModelError(`Couldn't change the mode: ${err.message}`);
      void queryClient.invalidateQueries({ queryKey: ['round-ups'] });
    });
  };
  const changeBase = (next: string) => {
    if (!roundUpId) return setDraftBase(next);
    if (!next) return;
    setModelError(undefined);
    api<RoundUp>('PATCH', `/api/sessions/${roundUpId}`, { baseBranch: next }).catch((err: Error) => setModelError(`Couldn't set the base branch: ${err.message}`));
  };

  const sidebar = (className?: string) => (
    <AppSidebar
      className={className}
      roundUps={roundUps}
      // A sub-agent's page sits under its round-up.
      currentId={current?.role === 'agent' ? current.parentId : roundUpId}
      inAgent={current?.role === 'agent'}
      onNavigate={() => {
        // On a phone the sidebar is a sheet over the chat; get it out of the way once something is picked.
        setMobileNav(false);
        clearActionError();
      }}
      onHide={() => (isMobile ? setMobileNav(false) : setNavOpen(false))}
      // Failures show through actionError; the sidebar has already put things back as they were.
      onRename={(id, title) => rename(id, title).catch(() => {})}
      onDelete={(id) =>
        remove(id).then(
          () => id === roundUpId && navigate('/', { replace: true }),
          () => {},
        )
      }
    />
  );
  const problem = modelError ?? actionError ?? error ?? listError;

  return (
    <TooltipProvider>
      {/* Keyed: each round-up opens with its pane closed and no tabs. */}
      <AgentPaneProvider key={roundUpId ?? 'new'} agents={agents ?? NO_AGENTS}>
        <div className="bg-canvas flex h-dvh gap-2.5 p-2.5 max-sm:p-0">
          {!isMobile && navOpen && sidebar()}
          {isMobile && (
            <Sheet open={mobileNav} onOpenChange={setMobileNav}>
              <SheetContent side="left" showCloseButton={false} className="w-[276px] border-0 bg-transparent p-2 shadow-none">
                <SheetTitle className="sr-only">Round-ups</SheetTitle>
                {sidebar('h-full w-full shadow-card')}
              </SheetContent>
            </Sheet>
          )}

          <main aria-label="Chat" className="bg-background shadow-card flex min-w-0 flex-1 flex-col overflow-hidden rounded-3xl max-sm:rounded-none">
            <header className="flex h-16 shrink-0 items-center gap-2.5 pr-4 pl-5">
              {(isMobile || !navOpen) && (
                <button
                  type="button"
                  onClick={() => (isMobile ? setMobileNav(true) : setNavOpen(true))}
                  aria-label="Show sidebar"
                  className="text-mu2 hover:bg-hov hover:text-fg -ml-2 flex size-[34px] items-center justify-center rounded-lg"
                >
                  <PanelLeftIcon className="size-[17px]" strokeWidth={1.7} />
                </button>
              )}
              {current?.role === 'agent' && current.parentId && <AgentCrumb agent={current} roundUp={roundUps?.find((r) => r.id === current.parentId)} />}
              <span className="flex-1" />
              <Search roundUps={roundUps} />
              <AgentsButton />
            </header>

            {onApprovals ? (
              <ApprovalsPage roundUps={roundUps} />
            ) : onChanges ? (
              <>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="mx-auto flex w-full max-w-[760px] flex-col gap-7 px-7 pt-1 pb-8 max-sm:px-4">
                    {current && <TitleBlock roundUp={current} agents={agents ?? NO_AGENTS} />}
                    {tabs}
                    <ChangesTab roundUpId={roundUpId} repo={current?.cwd.split('/').slice(-2).join('/')} />
                  </div>
                </div>
                <div className="mx-auto w-full max-w-[760px] px-7 max-sm:px-3">
                  <ApprovalTray approvals={approvals} roundUpId={roundUpId} docked />
                  {problem && <p className="text-fail mb-2 text-sm">{problem}</p>}
                </div>
              </>
            ) : onWorkbench ? (
              <WorkbenchPage cardId={linkedCard} />
            ) : onSettings ? (
              <SettingsPage />
            ) : (
              <>
                <ChatLog key={roundUpId ?? 'new'} id={roundUpId} content={items} className="min-h-0 flex-1">
                  <ConversationContent className="mx-auto flex min-h-full w-full max-w-[760px] flex-col gap-7 px-7 pt-1 pb-8 max-sm:px-4">
                    {current && <TitleBlock roundUp={current} agents={agents ?? NO_AGENTS} />}
                    {tabs}
                    {!roundUpId && items.length === 0 && <EmptyState cwd={cwd} />}
                    {items.map((item) =>
                      item.role === 'user' ? (
                        <div key={item.id} className="flex flex-col items-end gap-1.5">
                          <AttachmentChips sessionId={roundUpId} attachments={item.attachments} className="max-w-[78%]" />
                          {item.text && <div className="bg-raise max-w-[78%] rounded-[20px] px-4 py-[11px] break-words whitespace-pre-wrap">{item.text}</div>}
                        </div>
                      ) : (
                        <div key={item.id} className="flex min-w-0 flex-col gap-3.5">
                          <AssistantParts parts={item.parts} streaming={busy && item === last} actor={actor} sessionId={roundUpId} />
                        </div>
                      ),
                    )}
                    {/* Whenever the composer offers stop: the same busy state, whoever started the turn. */}
                    <WorkingStatus busy={busy} events={events} agents={agents ?? NO_AGENTS} />
                  </ConversationContent>
                  <ConversationScrollButton />
                </ChatLog>

                <div className="mx-auto w-full max-w-[760px] px-7 max-sm:px-3">
                  {/* The plan sits outside the chat flow, always in view while agents work. */}
                  {roundUpId && <ApprovalTray approvals={approvals} roundUpId={current?.role === 'agent' ? (current.parentId ?? roundUpId) : roundUpId} inChat={roundUpId} docked />}
                  {agents?.length ? <PlanDock settledAt={current?.updatedAt} /> : <TodoDock todos={todos} />}
                  {/* Below the tray (whose fade would cover it), next to the composer it is about. */}
                  {problem && <p className="text-fail mb-2 text-sm">{problem}</p>}
                  <Composer
                    status={status}
                    busy={busy}
                    send={send}
                    interrupt={interrupt}
                    model={model}
                    onModel={changeModel}
                    base={base}
                    onBase={changeBase}
                    branches={branches}
                    baseLocked={baseLocked}
                    baseClearable={!roundUpId}
                    // A sub-agent follows its round-up's mode; it is changed there.
                    mode={mode}
                    modes={current?.role === 'agent' ? [] : modes}
                    onMode={changeMode}
                  />
                </div>
              </>
            )}
          </main>
          <AgentPaneSlot />
        </div>
        {reviewable && nav.full && <FullScreen roundUpId={roundUpId} roundUpTitle={titleOf(current)} which={nav.full} />}
        {/* First run: until Claude Code is installed and signed in. Settings shows the same, so not there. */}
        <HarnessSetupDialog hidden={onSettings} />
      </AgentPaneProvider>
    </TooltipProvider>
  );
}
