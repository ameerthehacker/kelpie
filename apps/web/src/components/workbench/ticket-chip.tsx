import { TicketIcon } from 'lucide-react';
import type { Ticket } from '@kelpie/protocol';
import { Badge } from '@/components/ui/badge';

const SYSTEM: Record<Ticket['system'], string> = { jira: 'Jira', asana: 'Asana', linear: 'Linear', github: 'GitHub', other: '' };

/** The card's first ticket as a chip ("PLAT-88 Jira"), and how many more it has; each one's title on hover. */
export function TicketChips({ tickets }: { tickets: Ticket[] }) {
  const [first, ...rest] = tickets;
  if (!first) return null;
  const chip = (
    <>
      <TicketIcon className="text-run" strokeWidth={1.9} />
      <span className={first.system === 'other' ? 'text-fg2' : 'text-fg2 font-mono'}>{first.key}</span>
      {SYSTEM[first.system] && <span className="text-mu font-normal">{SYSTEM[first.system]}</span>}
      {rest.length > 0 && <span className="text-mu font-normal">+{rest.length}</span>}
    </>
  );
  const title = tickets.map((t) => [t.key, t.title].filter(Boolean).join(': ')).join('\n');
  return (
    <div className="flex">
      {first.url ? (
        <Badge asChild variant="secondary" className="bg-chip hover:bg-raise h-6 rounded-md px-2 text-[11px]">
          <a href={first.url} target="_blank" rel="noreferrer" title={title}>
            {chip}
          </a>
        </Badge>
      ) : (
        <Badge variant="secondary" title={title} className="bg-chip h-6 rounded-md px-2 text-[11px]">
          {chip}
        </Badge>
      )}
    </div>
  );
}
