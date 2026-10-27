import { useId, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { usePanelRef, type PanelImperativeHandle } from 'react-resizable-panels';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { CHAT_MIN, loadPaneWidth, PANE_DEFAULT, PANE_MAX_SHARE, PANE_MIN, savePaneWidth } from '@/lib/pane-width';
import { AgentPane } from './agent-pane';
import { useAgentPane } from './pane-state';

/** Tailwind's `lg`: from here the pane sits beside the chat; below it, it is a card over it. */
const WIDE = '(min-width: 1024px)';
const subscribeWide = (onChange: () => void) => {
  const mql = window.matchMedia(WIDE);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
};
const useWide = () => useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches);

/**
 * The chat (`children`, kept mounted as the pane opens and closes) and, on a wide screen, the
 * agent pane beside it, resizable by its handle and remembered at the width it was left. On a
 * narrower one the pane opens over the chat and doesn't resize.
 */
export function AgentPaneLayout({ children }: { children: ReactNode }) {
  const pane = useAgentPane();
  const wide = useWide();
  const docked = !!pane?.open && wide;
  const paneRef = usePanelRef();
  // Too narrow for both minimums, the chat keeps its own and the pane takes what is left. Only
  // this flips as the window resizes: new limits each frame would re-register the panel each time.
  const [group, setGroup] = useState<HTMLDivElement | null>(null);
  const [tight, setTight] = useState(false);
  useLayoutEffect(() => {
    if (!group) return;
    const measure = () => setTight(group.clientWidth < CHAT_MIN + PANE_MIN + HANDLE_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, [group]);

  return (
    <>
      {/* The library's `touch-action: pan-y` would stop pinch-zoom over the chat; only the handle needs it.
          Not clipped, so the cards keep their shadows. */}
      <ResizablePanelGroup
        elementRef={setGroup}
        className="min-w-0 flex-1 touch-auto!"
        style={{ overflow: 'visible' }}
        // Saved once a drag or a key press is done; not as a window resize squeezes the pane.
        onLayoutChanged={(_, meta) => {
          const size = paneRef.current?.getSize().inPixels;
          if (meta.isUserInteraction && size !== undefined) savePaneWidth(size);
        }}
      >
        <ResizablePanel id="chat" minSize={CHAT_MIN} className="flex touch-auto!" style={{ overflow: 'visible' }}>
          {children}
        </ResizablePanel>
        {docked && <DockedPane paneRef={paneRef} tight={tight} />}
      </ResizablePanelGroup>
      {pane?.open && !wide && <AgentPane agents={pane.agents} />}
    </>
  );
}

/** The gap between the two cards, which is also the handle's hit area. */
const HANDLE_PX = 10;
const PANE_MAX = `${PANE_MAX_SHARE * 100}%`;

function DockedPane({ paneRef: ref, tight }: { paneRef: RefObject<PanelImperativeHandle | null>; tight: boolean }) {
  const pane = useAgentPane()!;
  // Read as the pane opens, so it comes back at the width it was left. A new id each time it
  // opens: under the same one, the group would bring back the size it last had instead.
  const [width] = useState(loadPaneWidth);
  const id = `agent-pane-${useId()}`;
  // Not re-rendered as the group resizes.
  const content = useMemo(() => <AgentPane agents={pane.agents} docked />, [pane.agents]);

  return (
    <>
      <ResizableHandle
        // The separator's value is the chat's share (before it), so Home and End take the chat to its narrowest and widest.
        aria-label="Resize chat"
        // The library's own double-click goes back to `defaultSize`, which is the width restored.
        disableDoubleClick
        onDoubleClick={() => {
          ref.current?.resize(PANE_DEFAULT);
          savePaneWidth(PANE_DEFAULT);
        }}
        className="w-2.5 bg-transparent after:hidden before:absolute before:inset-y-6 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:rounded-full before:transition-colors data-[separator=active]:before:bg-acc data-[separator=focus]:before:bg-acc data-[separator=hover]:before:bg-fa focus-visible:ring-0"
      />
      <ResizablePanel
        id={id}
        panelRef={ref}
        defaultSize={width}
        minSize={tight ? 0 : PANE_MIN}
        maxSize={PANE_MAX}
        // A window resize gives or takes the chat's room; the pane keeps its width.
        groupResizeBehavior="preserve-pixel-size"
        className="flex touch-auto!"
        style={{ overflow: 'visible' }}
      >
        {content}
      </ResizablePanel>
    </>
  );
}
