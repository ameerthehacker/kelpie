import { TICKET_PROVIDER_NAME, ticketLabel, type CardTicket } from '@kelpie/protocol';

/** What showing a ticket needs: a round-up's linked ticket, or a Workbench card's. */
export type ShownTicket = CardTicket;

/** One linked ticket as the title block shows it. */
export interface TicketView {
  /** For React; a round-up lists each URL once. */
  id: string;
  /** Its key (`SHOP-412`), else its title, else what it is ("Asana task"). */
  label: string;
  /** Set when the label is a key: the key reads in the mono face. */
  mono: boolean;
  /** "Jira" or "Asana". */
  provider: string;
  /** Its title, when the label is the key and a title is known. */
  detail: string | undefined;
  href: string | undefined;
  /** What a screen reader says for its link. */
  aria: string;
}

/** Only web links open from the title block, whatever a ticket row holds. */
const safeHref = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
};

export function ticketView(t: ShownTicket): TicketView {
  const label = ticketLabel(t);
  const provider = TICKET_PROVIDER_NAME[t.provider];
  const mono = !!t.key && label === t.key;
  const detail = mono && t.title ? t.title : undefined;
  return {
    id: t.url,
    label,
    mono,
    provider,
    detail,
    href: safeHref(t.url),
    aria: `${label}${detail ? `: ${detail}` : ''}, ${provider} (opens in a new tab)`,
  };
}

/**
 * How the title block (or a Workbench card) shows its tickets: nothing, one ticket's chip, or an
 * "N tickets" chip that opens the list. Pure.
 */
export type TicketsDisplay = { kind: 'none' } | { kind: 'one'; ticket: TicketView } | { kind: 'many'; label: string; tickets: TicketView[] };

export function ticketsDisplay(tickets: readonly ShownTicket[] | undefined): TicketsDisplay {
  const views = (tickets ?? []).map(ticketView);
  if (!views.length) return { kind: 'none' };
  if (views.length === 1) return { kind: 'one', ticket: views[0]! };
  return { kind: 'many', label: `${views.length} tickets`, tickets: views };
}
