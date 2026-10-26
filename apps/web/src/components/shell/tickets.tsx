import { ArrowUpRightIcon, ChevronDownIcon, PencilIcon, TicketIcon, UnlinkIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useHiddenTickets, useTicketEdits } from '@/hooks/use-tickets';
import { ticketView, type ShownTicket, type TicketView } from '@/lib/tickets';
import { cn } from '@/lib/utils';

const chip =
  'border-ln2 text-fg2 hover:bg-raise data-[state=open]:bg-raise inline-flex h-6 max-w-64 min-w-0 items-center gap-1.5 rounded-md border px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-acc/40';
const icon = <TicketIcon aria-hidden="true" className="text-run size-3.5 shrink-0" strokeWidth={1.8} />;
const out = <ArrowUpRightIcon aria-hidden="true" className="text-fa size-3 shrink-0" strokeWidth={2} />;
const action = 'text-mu2 hover:text-fg hover:bg-raise flex size-6 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-acc/40';

const Label = ({ t }: { t: TicketView }) => <span className={cn('truncate', t.mono && 'font-mono text-[11.5px]')}>{t.label}</span>;

/** Renaming and unlinking a round-up's tickets; absent on a Workbench card's, which are the card's own. */
type Edits = ReturnType<typeof useTicketEdits>;
/** Where focus goes once a ticket's name is put back or saved, or a ticket is unlinked: a ticket's Rename button, or the list's trigger. */
type FocusTo = { rename: string } | 'trigger';

/**
 * A ticket's name, being edited. Enter saves it (an empty name clears the person's own, and a name
 * found or given later may take its place); Escape, or leaving the field empty, keeps what it was;
 * leaving it otherwise saves it.
 */
function TitleInput({ t, edits, onDone }: { t: TicketView; edits: Edits; onDone: (byKey: boolean) => void }) {
  const done = useRef(false);
  const finish = (value: string | undefined, byKey: boolean) => {
    if (done.current) return;
    done.current = true;
    const title = value?.trim();
    if (title !== undefined && t.ref && title !== t.title) edits.rename.mutate({ ref: t.ref, title });
    onDone(byKey);
  };
  return (
    <input
      autoFocus
      defaultValue={t.title}
      placeholder={t.label}
      aria-label={`Name ${t.label}`}
      maxLength={200}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(e.currentTarget.value, true);
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(undefined, true);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value.trim() ? e.currentTarget.value : undefined, false)}
      className="border-ln2 bg-surf text-fg focus:border-acc h-6 min-w-0 flex-1 rounded-md border px-1.5 text-xs outline-none"
    />
  );
}

/** Rename and Unlink for one ticket. */
function Actions({
  t,
  renameRef,
  onRename,
  onUnlink,
  className,
}: {
  t: TicketView;
  renameRef: (el: HTMLButtonElement | null) => void;
  onRename: () => void;
  onUnlink: () => void;
  className?: string;
}) {
  if (!t.ref) return null;
  return (
    <span className={cn('flex items-center', className)}>
      <button ref={renameRef} type="button" onClick={onRename} aria-label={`Rename ${t.label}`} title="Rename" className={action}>
        <PencilIcon aria-hidden="true" className="size-3" strokeWidth={2} />
      </button>
      <button type="button" onClick={onUnlink} aria-label={`Unlink ${t.label}`} title="Unlink from this round-up" className={action}>
        <UnlinkIcon aria-hidden="true" className="size-3" strokeWidth={2} />
      </button>
    </span>
  );
}

/**
 * The Jira and Asana tickets linked to a round-up, in its title block (and on its Workbench cards): one ticket is a chip
 * that opens it; several are an "N tickets" chip whose list opens each in a new tab. In the title block (given the
 * round-up) the person may rename or unlink each one, with a few seconds to undo an unlink; a name they give always stays.
 */
export function TicketChips({ tickets, roundUpId }: { tickets: readonly ShownTicket[] | undefined; roundUpId?: string }) {
  return roundUpId ? <EditableTickets tickets={tickets} roundUpId={roundUpId} /> : <TicketList views={(tickets ?? []).map(ticketView)} />;
}

function EditableTickets({ tickets, roundUpId }: { tickets: readonly ShownTicket[] | undefined; roundUpId: string }) {
  const edits = useTicketEdits(roundUpId);
  const hidden = useHiddenTickets(roundUpId);
  const views = (tickets ?? []).filter((t) => !t.ref || !hidden.has(t.ref)).map(ticketView);
  return <TicketList views={views} edits={edits} />;
}

function TicketList({ views, edits }: { views: TicketView[]; edits?: Edits }) {
  const [editing, setEditing] = useState<string>();
  const [open, setOpen] = useState(false);
  const [focusTo, setFocusTo] = useState<FocusTo>();
  const renames = useRef(new Map<string, HTMLButtonElement>());
  const trigger = useRef<HTMLButtonElement>(null);
  // Once the field or row it was on is gone, focus goes back where the person was, not to the page.
  useLayoutEffect(() => {
    if (!focusTo) return;
    (focusTo === 'trigger' ? trigger.current : renames.current.get(focusTo.rename))?.focus();
    setFocusTo(undefined);
  }, [focusTo]);
  if (!views.length) return null;

  const renameRef = (id: string) => (el: HTMLButtonElement | null) => void (el ? renames.current.set(id, el) : renames.current.delete(id));
  const doneEditing = (id: string) => (byKey: boolean) => {
    setEditing(undefined);
    if (byKey) setFocusTo({ rename: id });
  };
  const unlink = (t: TicketView, i: number) => {
    if (!edits || !t.ref) return;
    edits.unlink(t.ref, t.label);
    const next = views[i + 1] ?? views[i - 1];
    setFocusTo(next ? { rename: next.id } : 'trigger');
  };
  const error = edits?.rename.error && <span className="text-destructive text-xs">{edits.rename.error.message}</span>;

  // One ticket is a chip, unless its list is open (the person just unlinked the others from it).
  if (views.length === 1 && !open) {
    const t = views[0]!;
    if (edits && editing === t.id) {
      return (
        <span className="inline-flex w-64 items-center gap-1">
          {icon}
          <TitleInput t={t} edits={edits} onDone={doneEditing(t.id)} />
        </span>
      );
    }
    return (
      <span className="group/ticket inline-flex min-w-0 items-center gap-0.5">
        <a href={t.href} target="_blank" rel="noopener noreferrer" aria-label={t.aria} title={t.detail} className={chip}>
          {icon}
          <Label t={t} />
          <span className="text-mu2 text-[11px]">{t.provider}</span>
          {out}
        </a>
        {edits && (
          <Actions
            t={t}
            renameRef={renameRef(t.id)}
            onRename={() => setEditing(t.id)}
            onUnlink={() => unlink(t, 0)}
            className="opacity-0 group-focus-within/ticket:opacity-100 group-hover/ticket:opacity-100 pointer-coarse:opacity-100"
          />
        )}
        {error}
      </span>
    );
  }
  const label = `${views.length} ${views.length === 1 ? 'ticket' : 'tickets'}`;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setEditing(undefined);
      }}
    >
      <PopoverTrigger ref={trigger} className={chip} aria-label={`${label} linked`}>
        {icon}
        <span>{label}</span>
        <ChevronDownIcon aria-hidden="true" className="text-mu2 size-3 shrink-0" strokeWidth={2.2} />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        // Escape while naming a ticket only puts its name back.
        onEscapeKeyDown={(e) => editing && e.preventDefault()}
        className="bg-surf text-fg w-auto max-w-96 min-w-64 gap-0 rounded-xl p-1.5"
      >
        <p className="text-mu2 px-2 pt-1 pb-1.5 text-[11px]">Linked tickets</p>
        <ul>
          {views.map((t, i) => (
            <li key={t.id} className="group/row hover:bg-raise focus-within:bg-raise flex min-h-8 items-center gap-2 rounded-lg px-2 py-1 text-[13px]">
              {icon}
              {edits && editing === t.id ? (
                <TitleInput t={t} edits={edits} onDone={doneEditing(t.id)} />
              ) : (
                <a href={t.href} target="_blank" rel="noopener noreferrer" aria-label={t.aria} className="flex min-w-0 flex-1 items-center gap-1.5 outline-none">
                  <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <Label t={t} />
                    {t.detail && <span className="text-mu truncate text-xs">{t.detail}</span>}
                  </span>
                  <span className="text-mu2 ml-3 text-xs">{t.provider}</span>
                  {out}
                </a>
              )}
              {edits && <Actions t={t} renameRef={renameRef(t.id)} onRename={() => setEditing(t.id)} onUnlink={() => unlink(t, i)} />}
            </li>
          ))}
        </ul>
        {error && <p className="px-2 pt-1">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
