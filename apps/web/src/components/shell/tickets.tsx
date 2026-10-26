import { ArrowUpRightIcon, ChevronDownIcon, TicketIcon } from 'lucide-react';
import type { LinkedTicket } from '@kelpie/protocol';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ticketsDisplay, type TicketView } from '@/lib/tickets';
import { cn } from '@/lib/utils';

const chip =
  'border-ln2 text-fg2 hover:bg-raise data-[state=open]:bg-raise inline-flex h-6 max-w-64 min-w-0 items-center gap-1.5 rounded-md border px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-acc/40';
const icon = <TicketIcon aria-hidden="true" className="text-run size-3.5 shrink-0" strokeWidth={1.8} />;
const out = <ArrowUpRightIcon aria-hidden="true" className="text-fa size-3 shrink-0" strokeWidth={2} />;

const Label = ({ t }: { t: TicketView }) => <span className={cn('truncate', t.mono && 'font-mono text-[11.5px]')}>{t.label}</span>;

/**
 * The Jira and Asana tickets linked to a round-up, in its title block: one ticket is a chip
 * that opens it; several are an "N tickets" chip whose menu lists them, each opening in a new tab.
 */
export function TicketChips({ tickets }: { tickets: readonly LinkedTicket[] | undefined }) {
  const view = ticketsDisplay(tickets);
  if (view.kind === 'none') return null;
  if (view.kind === 'one') {
    const t = view.ticket;
    return (
      <a href={t.href} target="_blank" rel="noopener noreferrer" aria-label={t.aria} title={t.detail} className={chip}>
        {icon}
        <Label t={t} />
        <span className="text-mu2 text-[11px]">{t.provider}</span>
        {out}
      </a>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={chip} aria-label={`${view.label} linked`}>
        {icon}
        <span>{view.label}</span>
        <ChevronDownIcon aria-hidden="true" className="text-mu2 size-3 shrink-0" strokeWidth={2.2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="bg-surf text-fg w-auto max-w-80 min-w-56 rounded-xl p-1.5">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-mu2 px-2 pt-1 pb-1.5 text-[11px] font-normal">Linked tickets</DropdownMenuLabel>
          {view.tickets.map((t) => (
            <DropdownMenuItem key={t.id} asChild className="focus:bg-raise gap-2 rounded-lg px-2 py-1.5 text-[13px]">
              <a href={t.href} target="_blank" rel="noopener noreferrer" aria-label={t.aria}>
                {icon}
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <Label t={t} />
                  {t.detail && <span className="text-mu truncate text-xs">{t.detail}</span>}
                </span>
                <span className="text-mu2 ml-3 text-xs">{t.provider}</span>
                {out}
              </a>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
