import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { AgentSummary } from '@/lib/agents';

interface PaneState {
  open: boolean;
  /** Agents open as tabs, in the order they were opened. */
  tabs: string[];
  /** The tab on show; null shows the list of all agents. */
  active: string | null;
}

interface PaneApi extends PaneState {
  /** The round-up's agents, as the pane shows them. */
  agents: AgentSummary[];
  openAgent: (id: string) => void;
  closeTab: (id: string) => void;
  showList: () => void;
  toggleList: () => void;
  close: () => void;
}

const Ctx = createContext<PaneApi | undefined>(undefined);

/** The agent pane's open tabs. Mount it per round-up (keyed), so each starts closed. */
export function AgentPaneProvider({ agents, children }: { agents: AgentSummary[]; children: ReactNode }) {
  const [state, setState] = useState<PaneState>({ open: false, tabs: [], active: null });
  const openAgent = useCallback(
    (id: string) => setState((s) => ({ open: true, tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], active: id })),
    [],
  );
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
    () => ({ ...state, agents, openAgent, closeTab, showList, toggleList, close }),
    [state, agents, openAgent, closeTab, showList, toggleList, close],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** The pane, or undefined outside its provider. Its `agents` are empty on a page that is not an orchestrator's. */
export const useAgentPane = () => useContext(Ctx);
