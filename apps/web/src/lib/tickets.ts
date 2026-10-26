import { TICKET_PROVIDER_NAME, parseTicketUrl, ticketLabel, type CardTicket, type LinkedTicket } from '@kelpie/protocol';

/** What showing a ticket needs: a round-up's linked ticket (which the person may rename or unlink), or a Workbench card's. */
export type ShownTicket = CardTicket & Partial<Pick<LinkedTicket, 'ref' | 'titleSource'>>;

/** One linked ticket as the title block shows it. */
export interface TicketView {
  /** For React; a round-up lists each URL once. */
  id: string;
  /** How the API names it (`PATCH`/`DELETE /api/sessions/:id/tickets/:ref`); none on a Workbench card. */
  ref: string | undefined;
  /** Its title as the person would edit it; empty when it has none. */
  title: string;
  /** Its key (`SHOP-412`), else its title, else what it is ("Asana task …4821"). */
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
    ref: t.ref,
    title: t.title ?? '',
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

/** A link in pasted rich text: where it goes, and the text it showed. */
export interface PastedLink {
  href: string;
  text: string;
}

/**
 * Pasted text, with each Jira or Asana link the rich copy named written as `[name](url)`, so the
 * ticket is linked under that name: where the plain text holds the link itself it gets the name,
 * and where it holds only the name (rich apps copy a link's text, not its address) it gets the link.
 * The plain text as it was when there is nothing to add. Pure.
 */
export function ticketPaste(plain: string, links: readonly PastedLink[]): string {
  let out = plain;
  for (const { href, text } of links) {
    const name = text.replace(/\s+/g, ' ').trim();
    if (!name || name.includes(']') || !parseTicketUrl(href) || parseTicketUrl(name) || out.includes(`](${href})`)) continue;
    const md = `[${name}](${href})`;
    if (out.includes(href)) out = out.replace(href, md);
    else if (out.includes(name)) out = out.replace(name, md);
  }
  return out;
}
