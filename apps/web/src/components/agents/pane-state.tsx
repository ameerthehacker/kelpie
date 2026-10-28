import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ArtifactRef } from '@kelpie/protocol';
import type { AgentSummary } from '@/lib/agents';
import { paneKey } from '@/lib/artifacts';

interface PaneState {
  open: boolean;
  /** Agents (by id) and artifacts (by `paneKey`) open as tabs, in the order they were opened. */
  tabs: string[];
  /** The tab on show; null shows the list of all agents. */
  active: string | null;
}

interface PaneApi extends PaneState {
  /** The round-up the pane is for; undefined on a new round-up or a sub-agent's own page. */
  roundUpId: string | undefined;
  /** The round-up's agents, as the pane shows them. */
  agents: AgentSummary[];
  openAgent: (id: string) => void;
  /** Opens an artifact (a document, or an agent's code changes) in a tab of its own, or shows its tab. */
  openArtifact: (ref: ArtifactRef) => void;
  closeTab: (id: string) => void;
  showList: () => void;
  toggleList: () => void;
  close: () => void;
}

const Ctx = createContext<PaneApi | undefined>(undefined);

/** The agent pane's open tabs. Mount it per round-up (keyed), so each starts closed. */
export function AgentPaneProvider({ roundUpId, agents, children }: { roundUpId?: string; agents: AgentSummary[]; children: ReactNode }) {
  const [state, setState] = useState<PaneState>({ open: false, tabs: [], active: null });
  const openAgent = useCallback(
    (id: string) => setState((s) => ({ open: true, tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], active: id })),
    [],
  );
  const openArtifact = useCallback((ref: ArtifactRef) => openAgent(paneKey(ref)), [openAgent]);
  const closeTab = useCallback(
    (id: string) =>
      setState((s) => {
        const tabs = s.tabs.filter((t) => t !== id);
        return { ...s, tabs, active: s.active === id ? (tabs.at(-1) ?? null) : s.active };
      }),
    [],
  );
  const showList = useCallback(() => setState((s) => ({ ...s, open: true, active: null })), []);
  const toggleList = useCallback(() => setState((s) => (s.open && !s.active ? { ...s, open: false } : { ...s, open: true, active: null })), []);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  const api = useMemo(
    () => ({ ...state, roundUpId, agents, openAgent, openArtifact, closeTab, showList, toggleList, close }),
    [state, roundUpId, agents, openAgent, openArtifact, closeTab, showList, toggleList, close],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** The pane, or undefined outside its provider. Its `agents` are empty on a page that is not an orchestrator's. */
export const useAgentPane = () => useContext(Ctx);

const NOWHERE = () => {};

/**
 * Opens an artifact in the side panel, with "All" and the other open tabs beside it, e.g. from a
 * row of the Artifacts tab or of the chat's Progress card. Does nothing outside the pane's provider.
 */
export const useOpenArtifact = (): ((ref: ArtifactRef) => void) => useAgentPane()?.openArtifact ?? NOWHERE;

/** Whether that artifact's tab is the one on show in the open pane, for its row to show it selected. */
export function useArtifactOpen(ref: ArtifactRef): boolean {
  const pane = useAgentPane();
  return !!pane?.open && pane.active === paneKey(ref);
}
