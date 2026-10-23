import { MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from '@/components/ui/sidebar';
import { roundUpPath, statusLine, titleOf, type RoundUp } from '@/lib/round-ups';
import { cn } from '@/lib/utils';

/** The kelpie mark from the design canvas. */
export function KelpieMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={className}>
      <path d="M32 10.14 A16 16 0 1 1 13.71 11.74" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
      <circle cx="32" cy="10.14" r="4" fill="currentColor" />
      <circle cx="20" cy="22.5" r="3" fill="currentColor" />
      <circle cx="28" cy="22.5" r="3" fill="currentColor" />
      <circle cx="24" cy="29.5" r="3" fill="currentColor" />
    </svg>
  );
}

// Re-render once a minute so "5m ago" keeps moving.
function useNow(every = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

interface RowProps {
  roundUp: RoundUp;
  active: boolean;
  now: number;
  onNavigate: () => void;
  onRename: (id: string, title: string) => Promise<unknown>;
  onDelete: (roundUp: RoundUp) => void;
}

function RoundUpRow({ roundUp, active, now, onNavigate, onRename, onDelete }: RowProps) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const status = statusLine(roundUp, now);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const save = () => {
    const title = input.current?.value.trim();
    setEditing(false);
    if (title && title !== roundUp.title) void onRename(roundUp.id, title);
  };

  if (editing) {
    return (
      <SidebarMenuItem>
        <input
          ref={input}
          aria-label="Round-up title"
          defaultValue={titleOf(roundUp)}
          maxLength={200}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="bg-background focus-visible:ring-ring h-12 w-full rounded-md border px-2 text-sm outline-none focus-visible:ring-2"
        />
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild size="lg" isActive={active} className="h-auto min-h-12 py-1.5">
        <Link to={roundUpPath(roundUp.id)} aria-current={active ? 'page' : undefined} onClick={onNavigate}>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className={cn('truncate text-sm', !active && !roundUp.busy && 'text-sidebar-foreground/75')}>{titleOf(roundUp)}</span>
            <span
              className={cn(
                'truncate text-xs',
                status.tone === 'busy' && 'text-sidebar-foreground animate-pulse',
                status.tone === 'error' && 'text-destructive',
                status.tone === 'muted' && 'text-muted-foreground',
              )}
            >
              {status.text}
            </span>
          </span>
        </Link>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover className="top-3" aria-label={`Options for ${titleOf(roundUp)}`}>
            <MoreHorizontalIcon />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <PencilIcon /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => onDelete(roundUp)}>
            <Trash2Icon /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

interface SidebarProps {
  roundUps: RoundUp[] | undefined;
  currentId: string | undefined;
  /** Called when a link in the sidebar is followed. */
  onNavigate: () => void;
  onRename: (id: string, title: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
}

export function RoundUpSidebar({ roundUps, currentId, onNavigate, onRename, onDelete }: SidebarProps) {
  const now = useNow();
  const { isMobile, setOpenMobile } = useSidebar();
  const [confirming, setConfirming] = useState<RoundUp | undefined>();
  // On a phone the sidebar is a sheet over the chat; get it out of the way once something is picked.
  const navigated = () => {
    if (isMobile) setOpenMobile(false);
    onNavigate();
  };

  return (
    <Sidebar>
      <SidebarHeader className="gap-3.5 px-2.5 pt-3.5">
        <div className="flex h-8 items-center gap-2.5 px-2">
          <KelpieMark className="size-5.5" />
          <span className="text-[15px] font-semibold tracking-tight">kelpie</span>
        </div>
        <Button asChild variant="outline" className="h-10 justify-start gap-2.5 rounded-[10px] bg-transparent px-2.5 text-sm font-normal">
          <Link to="/" onClick={navigated}>
            <PlusIcon /> New round-up
          </Link>
        </Button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="px-2.5">
          <SidebarGroupLabel className="text-muted-foreground px-2.5 text-xs font-normal">Round-ups</SidebarGroupLabel>
          <SidebarMenu className="gap-0.5">
            {roundUps === undefined &&
              Array.from({ length: 3 }, (_, i) => (
                <SidebarMenuItem key={i}>
                  <SidebarMenuSkeleton />
                </SidebarMenuItem>
              ))}
            {roundUps?.length === 0 && <p className="text-muted-foreground px-2.5 py-2 text-xs">Nothing yet. Your round-ups show up here.</p>}
            {roundUps?.map((r) => (
              <RoundUpRow
                key={r.id}
                roundUp={r}
                active={r.id === currentId}
                now={now}
                onNavigate={navigated}
                onRename={onRename}
                onDelete={setConfirming}
              />
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <Dialog open={!!confirming} onOpenChange={(open) => !open && setConfirming(undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{titleOf(confirming)}”?</DialogTitle>
            <DialogDescription>
              Its conversation is removed from Kelpie, and any work in progress is stopped. Claude Code’s own transcript stays in ~/.claude.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirming) void onDelete(confirming.id);
                setConfirming(undefined);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  );
}
