import { useLayoutEffect, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { usePanelRef, type PanelImperativeHandle } from 'react-resizable-panels';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { loadPaneWidth, PANE_DEFAULT, paneLimits, savePaneWidth } from '@/lib/pane-width';
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

/** The gap between the two cards, which is also the handle's hit area. */
const HANDLE_PX = 10;

/**
 * The chat (`children`, kept mounted as the pane opens and closes) and, on a wide screen, the
 * agent pane beside it, resizable by its handle and remembered at the width it was left. On a
 * narrower one the pane opens over the chat and doesn't resize.
 */
export function AgentPaneLayout({ children }: { children: ReactNode }) {
  const pane = useAgentPane();
  const wide = useWide();
  const docked = !!pane?.open && wide;
  // The room the chat and the pane share, for the pane's limits in pixels.
  const [group, setGroup] = useState<HTMLDivElement | null>(null);
  const [room, setRoom] = useState<number>();
  const paneRef = usePanelRef();
  useLayoutEffect(() => {
    if (!group) return;
    const measure = () => setRoom(group.clientWidth - HANDLE_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, [group]);

  return (
    <>
      <ResizablePanelGroup
        elementRef={setGroup}
        className="min-w-0 flex-1"
        // Saved once a drag or a key press is done; not as a window resize squeezes the pane.
        onLayoutChanged={(_, meta) => {
          const size = paneRef.current?.getSize().inPixels;
          if (meta.isUserInteraction && size !== undefined) savePaneWidth(size);
        }}
      >
        <ResizablePanel id="chat" className="flex" style={{ overflow: 'visible' }}>
          {children}
        </ResizablePanel>
        {docked && room !== undefined && <DockedPane room={room} paneRef={paneRef} />}
      </ResizablePanelGroup>
      {pane?.open && !wide && <AgentPane agents={pane.agents} />}
    </>
  );
}

function DockedPane({ room, paneRef: ref }: { room: number; paneRef: RefObject<PanelImperativeHandle | null> }) {
  const pane = useAgentPane()!;
  // Read as the pane opens, so it comes back at the width it was left.
  const [width] = useState(loadPaneWidth);
  const { min, max } = paneLimits(room);

  return (
    <>
      <ResizableHandle
        aria-label="Resize agent pane"
        // The library's own double-click goes back to `defaultSize`, which is the width restored.
        disableDoubleClick
        onDoubleClick={() => {
          ref.current?.resize(PANE_DEFAULT);
          savePaneWidth(PANE_DEFAULT);
        }}
        className="w-2.5 bg-transparent after:hidden before:absolute before:inset-y-6 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:rounded-full before:transition-colors data-[separator=active]:before:bg-acc data-[separator=focus]:before:bg-acc data-[separator=hover]:before:bg-fa focus-visible:ring-0"
      />
      <ResizablePanel
        id="agent-pane"
        panelRef={ref}
        defaultSize={width}
        minSize={min}
        maxSize={max}
        // A window resize gives or takes the chat's room; the pane keeps its width.
        groupResizeBehavior="preserve-pixel-size"
        className="flex"
        style={{ overflow: 'visible' }}
      >
        <AgentPane agents={pane.agents} docked />
      </ResizablePanel>
    </>
  );
}
