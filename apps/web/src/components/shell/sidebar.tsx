import { MoreHorizontalIcon, PanelLeftIcon, PencilIcon, PlusIcon, SettingsIcon, ShieldAlertIcon, SquareKanbanIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useMatch } from 'react-router';
import { StatusDot } from '@/components/agents/agent-bits';
import { HarnessMark } from '@/components/harness-mark';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useApprovals } from '@/hooks/use-approvals';
import { useNow } from '@/hooks/use-now';
import { useRoundUpStatus } from '@/hooks/use-round-up-status';
import { useUsage } from '@/hooks/use-usage';
import { useWorkbench } from '@/hooks/use-workbench';
import { harnessOf } from '@/lib/harnesses';
import { relativeTime, roundUpPath, statusLine, titleOf, type RoundUp } from '@/lib/round-ups';
import { GROUP_LABEL, type PlanGroup } from '@/lib/status';
import { metersOf } from '@/lib/usage';
import { pausedStatus } from '@/lib/limits';
import { needsYouTotal } from '@/lib/workbench';
import { cn } from '@/lib/utils';
import { KelpieLogo, Wordmark } from './brand';
import { NotificationPrompt, NotificationsMenu } from './notifications-menu';
import { ThemeSwitch } from './theme-switch';

interface RowProps {
  roundUp: RoundUp;
  /** Open: the page itself, or the place a sub-agent's page sits under. */
  active: 'page' | 'location' | undefined;
  now: number;
  onNavigate: () => void;
  onRename: (id: string, title: string) => Promise<unknown>;
  onDelete: (roundUp: RoundUp) => void;
  /** How many things it is waiting on the person for. */
  waiting: number;
  /** The whole round-up's state, its sub-agents included (see `roundUpStatus`). */
  status: PlanGroup | undefined;
}

/**
 * A round-up in the list: its title, and a dot for the whole round-up — how many things wait on the
 * person, red if a turn failed, pulsing while anything works, a green ring while branches wait to be
 * merged, a grey one if stopped, green once done. Rename and delete on its menu.
 */
function RoundUpRow({ roundUp, active, now, onNavigate, onRename, onDelete, waiting, status }: RowProps) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Read out with the link, and its tooltip: the dot is hidden under the menu button on hover.
  const label =
    status === 'needs-you'
      ? `${GROUP_LABEL[status]} · ${waiting} waiting`
      : status === 'working'
        ? GROUP_LABEL[status]
        : status === 'paused' && roundUp.limited
          ? pausedStatus(roundUp.limited, now)
        : status
          ? `${GROUP_LABEL[status]} · ${relativeTime(roundUp.updatedAt, now)}`
          : statusLine(roundUp, now).text;

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
      <input
        ref={input}
        aria-label="Round-up title"
        defaultValue={titleOf(roundUp)}
        maxLength={200}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(false);
          }
        }}
        className="bg-surf border-ln2 h-[38px] w-full rounded-[10px] border px-3 text-sm outline-none"
      />
    );
  }

  return (
    <div className="group/row relative">
      <Link
        to={roundUpPath(roundUp.id)}
        aria-current={active}
        title={label}
        onClick={onNavigate}
        className={cn('hover:bg-hov flex h-[38px] items-center gap-2.5 rounded-[10px] pr-9 pl-3 text-sm', active && 'bg-sel font-medium')}
      >
        <span className={cn('min-w-0 flex-1 truncate', active || status === 'working' || status === 'needs-you' ? 'text-fg' : 'text-mu', status === 'failed' && 'text-fail')}>
          {titleOf(roundUp)}
        </span>
        <span className="sr-only">{label}</span>
      </Link>
      {status === 'needs-you' && waiting > 0 ? (
        <span
          aria-hidden="true"
          className="bg-wait text-onwait absolute top-1/2 right-2 min-w-5 -translate-y-1/2 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold group-hover/row:opacity-0"
        >
          {waiting}
        </span>
      ) : (
        status && <StatusDot status={status} className="absolute top-1/2 right-3 -translate-y-1/2 group-hover/row:opacity-0" />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Options for ${titleOf(roundUp)}`}
          className="text-mu2 hover:text-fg data-[state=open]:text-fg absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontalIcon className="size-4" />
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
    </div>
  );
}

/** Each harness's subscription windows as compact meters; the reset time shows once a window runs high. */
function Usage({ now }: { now: number }) {
  const { data: usage, isPending, isError } = useUsage();
  return (
    <section aria-label="Usage limits" className="flex flex-col gap-3.5 px-2.5 pt-4 pb-3.5">
      {isPending && <Skeleton className="h-12 w-full" />}
      {isError && <p className="text-mu2 text-xs">Couldn’t load usage from the daemon.</p>}
      {usage?.length === 0 && <p className="text-mu2 text-xs">Usage shows up after Claude Code’s first turn.</p>}
      {usage?.map((u) => {
        const name = harnessOf(u.harness).name;
        return (
          <div key={u.harness} className="flex flex-col gap-1.5">
            <div className="text-fg2 flex items-center gap-2 text-[13px]">
              <HarnessMark harness={u.harness} />
              {name}
            </div>
            {metersOf(u, now).map((m) => (
              <div key={m.label} className="flex flex-col gap-1">
                <div title={m.reset} className="grid grid-cols-[48px_1fr_34px] items-center gap-2 text-xs">
                  <span className="text-mu2">{m.short}</span>
                  <div
                    role="meter"
                    aria-label={`${name} ${m.label.toLowerCase()}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={m.pct}
                    className="bg-ln2 h-1 overflow-hidden rounded-full"
                  >
                    <div className={cn('h-full rounded-full', m.warn ? 'bg-wait' : 'bg-fg3')} style={{ width: `${m.pct}%` }} />
                  </div>
                  <span className={cn('text-right font-mono text-[11px]', m.warn ? 'text-wait' : 'text-mu')}>{m.pct}%</span>
                </div>
                {m.warn && <div className="text-mu2 pl-14 text-[11px]">{m.reset}</div>}
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}

interface SidebarProps {
  roundUps: RoundUp[] | undefined;
  currentId: string | undefined;
  /** A sub-agent of `currentId` is open, not the round-up's own chat. */
  inAgent?: boolean;
  /** Called when a link in the sidebar is followed. */
  onNavigate: () => void;
  onRename: (id: string, title: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onHide: () => void;
  className?: string;
}

/** The round-ups, usage, notifications and theme: the design's left-hand panel. */
export function AppSidebar({ roundUps, currentId, inAgent, onNavigate, onRename, onDelete, onHide, className }: SidebarProps) {
  const now = useNow();
  const approvals = useApprovals();
  const statusOf = useRoundUpStatus();
  const waiting = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of approvals) counts.set(a.roundUpId, (counts.get(a.roundUpId) ?? 0) + 1);
    return counts;
  }, [approvals]);
  const [confirming, setConfirming] = useState<RoundUp | undefined>();
  const onWorkbench = !!useMatch({ path: '/workbench', end: false });
  const boardWaiting = needsYouTotal(useWorkbench().cards, now);
  const onSettings = !!useMatch('/settings');

  return (
    <nav aria-label="Round-ups" className={cn('bg-side flex w-[260px] shrink-0 flex-col gap-1.5 rounded-[22px] px-3 pt-3.5 pb-3', className)}>
      <div className="flex h-9 items-center gap-2.5 pr-1.5 pl-2">
        <KelpieLogo className="size-7" />
        <Wordmark className="flex-1" />
        <button type="button" onClick={onHide} aria-label="Hide sidebar" className="text-mu2 hover:bg-hov hover:text-fg flex size-8 items-center justify-center rounded-lg">
          <PanelLeftIcon className="size-[17px]" strokeWidth={1.7} />
        </button>
      </div>

      <Link to="/" onClick={onNavigate} className="bg-chip hover:bg-raise mt-2.5 flex h-10 items-center gap-2.5 rounded-xl px-3 text-sm font-medium">
        <PlusIcon className="size-4" strokeWidth={2} />
        New round-up
      </Link>
      <Link
        to="/workbench"
        onClick={onNavigate}
        aria-current={onWorkbench ? 'page' : undefined}
        title={boardWaiting ? `${boardWaiting} on the Workbench waiting on you` : undefined}
        className={cn('hover:bg-hov mb-3.5 flex h-[38px] items-center gap-2.5 rounded-[10px] px-3 text-sm', onWorkbench && 'bg-sel font-medium')}
      >
        <SquareKanbanIcon className="text-fg2 size-4" strokeWidth={1.8} />
        <span className="flex-1">Workbench</span>
        {boardWaiting > 0 && (
          <span className="text-wait text-xs font-semibold">
            {boardWaiting}
            <span className="sr-only"> need you</span>
          </span>
        )}
      </Link>

      {approvals.length > 0 && (
        <Link to="/approvals" onClick={onNavigate} className="bg-wbg text-fg hover:bg-hov -mt-2 mb-2 flex h-9 items-center gap-2.5 rounded-xl px-3 text-sm">
          <ShieldAlertIcon className="text-wait size-4" strokeWidth={2} />
          <span className="flex-1">Waiting on you</span>
          <span className="text-wait text-xs font-semibold">{approvals.length}</span>
        </Link>
      )}
      <div className="text-mu2 px-2.5 pb-1 text-xs">Round-ups</div>
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1">
        {roundUps === undefined && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="my-1 h-[30px] rounded-[10px]" />)}
        {roundUps?.length === 0 && <p className="text-mu2 px-2.5 py-2 text-xs">Nothing yet. Your round-ups show up here.</p>}
        {roundUps?.map((r) => (
          <RoundUpRow
            key={r.id}
            roundUp={r}
            active={r.id !== currentId ? undefined : inAgent ? 'location' : 'page'}
            now={now}
            onNavigate={onNavigate}
            onRename={onRename}
            onDelete={setConfirming}
            waiting={waiting.get(r.id) ?? 0}
            status={statusOf(r)}
          />
        ))}
      </div>

      <NotificationPrompt />

      <Usage now={now} />

      <Link
        to="/settings"
        onClick={onNavigate}
        aria-current={onSettings ? 'page' : undefined}
        className={cn('text-mu hover:bg-hov hover:text-fg mb-1 flex h-9 items-center gap-2.5 rounded-[10px] px-2.5 text-[13px]', onSettings && 'bg-sel text-fg font-medium')}
      >
        <SettingsIcon className="size-4" strokeWidth={1.8} />
        Settings
      </Link>

      <div className="flex items-center gap-1.5 pl-2.5">
        <span className="text-mu2 flex-1 text-[13px]">Notifications</span>
        <NotificationsMenu />
      </div>
      <div className="flex items-center gap-1.5 pl-2.5">
        <span className="text-mu2 flex-1 text-[13px]">Theme</span>
        <ThemeSwitch />
      </div>

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
    </nav>
  );
}
