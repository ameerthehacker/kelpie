import { ArrowUpRightIcon, ChevronDownIcon, PencilIcon, TicketIcon, UnlinkIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useTicketEdits } from '@/hooks/use-tickets';
import { ticketsDisplay, type ShownTicket, type TicketView } from '@/lib/tickets';
import { cn } from '@/lib/utils';

const chip =
  'border-ln2 text-fg2 hover:bg-raise data-[state=open]:bg-raise inline-flex h-6 max-w-64 min-w-0 items-center gap-1.5 rounded-md border px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-acc/40';
const icon = <TicketIcon aria-hidden="true" className="text-run size-3.5 shrink-0" strokeWidth={1.8} />;
const out = <ArrowUpRightIcon aria-hidden="true" className="text-fa size-3 shrink-0" strokeWidth={2} />;
const action = 'text-mu2 hover:text-fg hover:bg-raise flex size-6 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-acc/40';

const Label = ({ t }: { t: TicketView }) => <span className={cn('truncate', t.mono && 'font-mono text-[11.5px]')}>{t.label}</span>;

/** Renaming and unlinking a round-up's tickets; absent on a Workbench card's, which are the card's own. */
type Edits = ReturnType<typeof useTicketEdits>;

/**
 * A ticket's name, being edited: Enter or leaving the field saves it (empty clears the person's
 * name, so a found one shows again), Escape keeps what it was.
 */
function TitleInput({ t, edits, onDone }: { t: TicketView; edits: Edits; onDone: () => void }) {
  const done = useRef(false);
  const finish = (save: boolean, value: string) => {
    if (done.current) return;
    done.current = true;
    if (save && t.ref && value.trim() !== t.title) edits.rename.mutate({ ref: t.ref, title: value.trim() });
    onDone();
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
        if (e.key === 'Enter') finish(true, e.currentTarget.value);
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(false, '');
        }
      }}
      onBlur={(e) => finish(true, e.currentTarget.value)}
      className="border-ln2 bg-surf text-fg focus:border-acc h-6 min-w-0 flex-1 rounded-md border px-1.5 text-xs outline-none"
    />
  );
}

/** Rename and Unlink for one ticket. */
function Actions({ t, edits, onRename, className }: { t: TicketView; edits: Edits; onRename: () => void; className?: string }) {
  if (!t.ref) return null;
  const ref = t.ref;
  return (
    <span className={cn('flex items-center', className)}>
      <button type="button" onClick={onRename} aria-label={`Rename ${t.label}`} title="Rename" className={action}>
        <PencilIcon aria-hidden="true" className="size-3" strokeWidth={2} />
      </button>
      <button type="button" onClick={() => edits.unlink.mutate(ref)} aria-label={`Unlink ${t.label}`} title="Unlink from this round-up" className={action}>
        <UnlinkIcon aria-hidden="true" className="size-3" strokeWidth={2} />
      </button>
    </span>
  );
}

/**
 * The Jira and Asana tickets linked to a round-up, in its title block (and on its Workbench cards): one ticket is a chip
 * that opens it; several are an "N tickets" chip whose list opens each in a new tab. In the title block (given the
 * round-up) the person may rename or unlink each one; a name they give always stays.
 */
export function TicketChips({ tickets, roundUpId }: { tickets: readonly ShownTicket[] | undefined; roundUpId?: string }) {
  const view = ticketsDisplay(tickets);
  if (view.kind === 'none') return null;
  return roundUpId ? <EditableTickets view={view} roundUpId={roundUpId} /> : <TicketList view={view} />;
}

function EditableTickets({ view, roundUpId }: { view: Exclude<ReturnType<typeof ticketsDisplay>, { kind: 'none' }>; roundUpId: string }) {
  const edits = useTicketEdits(roundUpId);
  return <TicketList view={view} edits={edits} />;
}

function TicketList({ view, edits }: { view: Exclude<ReturnType<typeof ticketsDisplay>, { kind: 'none' }>; edits?: Edits }) {
  const [editing, setEditing] = useState<string>();
  const error = edits?.error && <span className="text-destructive text-xs">{edits.error.message}</span>;
  if (view.kind === 'one') {
    const t = view.ticket;
    if (edits && editing === t.id) {
      return (
        <span className="inline-flex w-64 items-center gap-1">
          {icon}
          <TitleInput t={t} edits={edits} onDone={() => setEditing(undefined)} />
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
            edits={edits}
            onRename={() => setEditing(t.id)}
            className="opacity-0 group-focus-within/ticket:opacity-100 group-hover/ticket:opacity-100 pointer-coarse:opacity-100"
          />
        )}
        {error}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Popover onOpenChange={(open) => !open && setEditing(undefined)}>
        <PopoverTrigger className={chip} aria-label={`${view.label} linked`}>
          {icon}
          <span>{view.label}</span>
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
            {view.tickets.map((t) => (
              <li key={t.id} className="group/row hover:bg-raise focus-within:bg-raise flex min-h-8 items-center gap-2 rounded-lg px-2 py-1 text-[13px]">
                {icon}
                {edits && editing === t.id ? (
                  <TitleInput t={t} edits={edits} onDone={() => setEditing(undefined)} />
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
                {edits && <Actions t={t} edits={edits} onRename={() => setEditing(t.id)} />}
              </li>
            ))}
          </ul>
          {error && <p className="px-2 pt-1">{error}</p>}
        </PopoverContent>
      </Popover>
    </span>
  );
}
