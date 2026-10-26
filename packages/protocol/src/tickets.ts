import { z } from 'zod';

/**
 * Tickets linked to a round-up: Jira issues and Asana tasks or projects, known only by their
 * links (Kelpie has no credentials for either). The person's messages are scanned for them, and
 * the orchestrator links (and titles) the ones it finds.
 */

export const TicketProvider = z.enum(['jira', 'asana']);
export type TicketProvider = z.infer<typeof TicketProvider>;

export const TicketKind = z.enum(['issue', 'task', 'project']);
export type TicketKind = z.infer<typeof TicketKind>;

/**
 * Where a ticket's title came from, weakest first: the text the person's message linked it with,
 * the orchestrator, or the person renaming it in Kelpie. A title only replaces one from the same
 * source or a weaker one, so the person's own name for a ticket always stays.
 */
export const TicketTitleSource = z.enum(['link', 'orchestrator', 'person']);
export type TicketTitleSource = z.infer<typeof TicketTitleSource>;

const TITLE_RANK: Record<TicketTitleSource, number> = { link: 1, orchestrator: 2, person: 3 };

/** Whether a title from `next` may replace the one a ticket has (from `current`, if it has one). Pure. */
export const titleWins = (next: TicketTitleSource, current: TicketTitleSource | null | undefined): boolean =>
  !current || TITLE_RANK[next] >= TITLE_RANK[current];

/** A ticket as a round-up lists it. */
export const LinkedTicket = z.object({
  /** What makes it the same ticket whichever form its link takes (see TicketLink); how the API names it. */
  ref: z.string(),
  provider: TicketProvider,
  kind: TicketKind,
  /** Where it opens: a Jira issue's `/browse/KEY` page, or the Asana link as it was shared. */
  url: z.string(),
  /** A Jira issue's key (`SHOP-412`); Asana links carry none. */
  key: z.string().optional(),
  /** A readable name: the link's text in the person's message, or one the orchestrator or the person gave. */
  title: z.string().optional(),
  /** Where `title` came from. */
  titleSource: TicketTitleSource.optional(),
  /** Found in the person's message, or linked by the orchestrator. */
  source: z.enum(['auto', 'orchestrator']),
  /** Epoch ms. */
  addedAt: z.number(),
});
export type LinkedTicket = z.infer<typeof LinkedTicket>;

/** A ticket link, understood. */
export interface TicketLink {
  provider: TicketProvider;
  kind: TicketKind;
  url: string;
  key?: string;
  /** What makes it the same ticket whichever form its link takes: `jira:<host>/<KEY>`, `asana:task:<id>`. */
  ref: string;
  /** What the message named it, when it linked it with readable text (see findTickets). */
  title?: string;
}

const JIRA_KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;
const ASANA_ID = /^\d+$/;
/** The views of an Asana project a classic (`/0/`) link can open. */
const ASANA_VIEWS = new Set(['list', 'board', 'overview', 'timeline', 'calendar', 'messages', 'progress', 'files', 'workflow', 'dashboard', 'gantt']);

const isJiraHost = (host: string) => host.endsWith('.atlassian.net') || host.endsWith('.jira.com') || /^jira[.-]/.test(host);

function jiraKey(u: URL): string | undefined {
  const selected = u.searchParams.get('selectedIssue')?.toUpperCase();
  if (selected && JIRA_KEY.test(selected)) return selected;
  const parts = u.pathname.split('/').filter(Boolean);
  const browse = parts.indexOf('browse');
  // /browse/KEY-123 (Cloud and Server), or /jira/<app>/…/issues/KEY-123 and the like.
  const candidates = browse >= 0 ? parts.slice(browse + 1, browse + 2) : parts[0] === 'jira' ? [...parts].reverse() : [];
  return candidates.map((p) => decodeURIComponent(p).toUpperCase()).find((p) => JIRA_KEY.test(p));
}

function asana(u: URL): Pick<TicketLink, 'kind' | 'ref'> | undefined {
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === '0') {
    // Classic links: /0/<project>/<task>[/f], /0/0/<task>, or a project view /0/<project>[/list].
    const [, project, ...rest] = parts;
    if (!project || !ASANA_ID.test(project)) return undefined; // inbox, home, search, portfolios…
    const tasks = rest.filter((p) => ASANA_ID.test(p));
    if (tasks.length) return { kind: 'task', ref: `asana:task:${tasks.at(-1)}` };
    if (project !== '0' && (!rest.length || ASANA_VIEWS.has(rest[0]!))) return { kind: 'project', ref: `asana:project:${project}` };
    return undefined;
  }
  if (parts[0] === '1') {
    // Newer links: /1/<workspace>/project/<project>/task/<task>, /1/<workspace>/task/<task>, /1/<workspace>/project/<project>[/list…].
    const after = (name: string) => {
      const i = parts.indexOf(name, 2);
      const id = i >= 0 ? parts[i + 1] : undefined;
      return id && ASANA_ID.test(id) ? id : undefined;
    };
    if (parts.includes('inbox', 2)) return undefined;
    const task = after('task');
    if (task) return { kind: 'task', ref: `asana:task:${task}` };
    const project = after('project');
    if (project) return { kind: 'project', ref: `asana:project:${project}` };
  }
  return undefined;
}

/** A Jira or Asana ticket's link, understood; undefined for any other link (or text). Pure. */
export function parseTicketUrl(text: string): TicketLink | undefined {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  const host = u.hostname.toLowerCase();
  if (isJiraHost(host)) {
    const key = jiraKey(u);
    if (!key) return undefined;
    // Server installs may live under a path (`/jira/browse/…`); Cloud's board links are opened as the issue page.
    const base = u.pathname.match(/^(.*?)\/browse\//)?.[1] ?? '';
    return { provider: 'jira', kind: 'issue', url: `${u.protocol}//${u.host}${base}/browse/${key}`, key, ref: `jira:${host}/${key}` };
  }
  if (host === 'app.asana.com') {
    const found = asana(u);
    if (!found) return undefined;
    u.protocol = 'https:';
    u.hash = '';
    return { provider: 'asana', ...found, url: u.toString() };
  }
  return undefined;
}

const URLS = /https?:\/\/[^\s<>"'`()[\]{}|\\^]+/gi;
/** `[text](url)`, the way markdown (and Kelpie's composer, for pasted rich text) links a ticket by name; not an image's `![alt](url)`. */
const MD_LINKS = /(?<!!)\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/gi;
const TITLE_MAX = 200;
/** Longer lines are only searched for links, never for names: the name heuristics are not linear in a line's length. */
const NAMED_LINE_MAX = 500;
/** A list item's marker, after any quote markers: `- `, `* `, `+ `, `• `, `1. `, `1) `. */
const LIST_ITEM = /^\s*(?:>\s*)*(?:[-*+•]|\d+[.)])\s+/;
/** Words that say where a link is, not what it is: "see here", "this ticket", "Asana task". */
const VAGUE = /^(?:(?:see|link|here|this|that|the|a|an|it|ticket|task|issue|project|card|story|bug|epic|jira|asana|board|related|ref|re|cc|fyi|url|page|details?|more)\b[\s:.\-]*)+$/i;
/** How a sentence about a link starts, as opposed to a name for it ("Can you look at this: …"). */
const SENTENCE = /^(?:please|pls|can|could|would|will|should|let'?s|see|check|look|here|there|i|i'm|im|we|you|this|that|these|those|it|for|from|in|on|at|per|related|ref|re|also|and|or|but|so|then|via|with)\b/i;
/** How a sentence pointing at a link ends ("Fix this: …", "Blocked by: …", "Not urgent, but: …"). */
const POINTING = /(?:\b(?:this|that|these|those|it|here|below|one|ones|by|in|to|of|for|from|with|at|on|see|via|and|or|but|so|as|is|are|was|were)|,)$/i;
/** Between a name and its link on one line: `Name: url`, `Name - url`, `url — Name`, `Name | url`. */
const SEPARATOR = /^\s*(?::|-|–|—|\|)\s+|\s+(?:-|–|—|\|)\s*$|:\s*$/;

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

/** A ticket's readable name from text it was linked with, or undefined when the text is not one. */
function nameFrom(text: string, t: TicketLink): string | undefined {
  let name = tidy(text.replace(/[*_`~]+/g, ' '));
  // A Jira key at the front is shown already: "SHOP-412: Guest checkout" names it "Guest checkout".
  // Only the key itself: "SHOP-4120 Rounding" is not SHOP-412's.
  if (t.key && new RegExp(`^${t.key}(?![A-Z0-9_])`, 'i').test(name)) name = name.slice(t.key.length).replace(/^[\s:\-–—|]+/, '');
  if (!name || name.length > TITLE_MAX || VAGUE.test(name) || parseTicketUrl(name) || /^https?:/i.test(name)) return undefined;
  return name;
}

/**
 * A name for the one ticket on a list item, from text set off from its link: "- Guest checkout flake: <url>",
 * "- <url> — Guest checkout flake". Kept conservative: a list item, two words or more starting with a
 * capital or a digit, set off by a separator, not a question or a sentence about the link.
 */
function nameOnLine(line: string, url: string, t: TicketLink): string | undefined {
  const item = line.match(LIST_ITEM);
  if (!item) return undefined;
  const at = line.indexOf(url);
  const before = line.slice(item[0].length, at).replace(/[<(*_]+$/, '');
  const after = line.slice(at + url.length).replace(/^[>)*_.,;!?]+/, '');
  // The link at one end of its line, its name at the other.
  const [side, other] = before.trim() ? [before, after] : [after, before];
  if (other.trim() || !SEPARATOR.test(side)) return undefined;
  const text = tidy(side.replace(/^\s*(?::|-|–|—|\|)\s+/, '').replace(/\s*(?::|-|–|—|\|)\s*$/, ''));
  if (text.includes('?') || !/^[\p{Lu}\d]/u.test(text) || SENTENCE.test(text) || POINTING.test(text) || text.split(' ').length < 2) return undefined;
  return nameFrom(text, t);
}

/**
 * Every Jira or Asana ticket linked in a piece of text, first mention first, each once, with a title
 * when the text names it: a markdown link's text (`[Guest checkout](url)`), else a name set off from
 * the link in a list item (`- Guest checkout flake: url`). Names never come from code or overlong
 * lines. Bare keys ("SHOP-412") are left alone: without a link there is no telling where they live. Pure.
 */
export function findTickets(text: string): TicketLink[] {
  const found = new Map<string, TicketLink>();
  const linked = new Map<string, string>();
  const listed = new Map<string, string>();
  let fenced = false;
  for (const line of text.split('\n')) {
    const fence = /^\s*(?:`{3,}|~{3,})/.test(line);
    if (fence) fenced = !fenced;
    const links = [...line.matchAll(URLS)].map(([m]) => m.replace(/[.,;:!?*_~]+$/, ''));
    for (const url of links) {
      // Sentence punctuation and markdown emphasis after a link are not part of it.
      const t = parseTicketUrl(url);
      if (t && !found.has(t.ref)) found.set(t.ref, t);
    }
    if (fenced || fence || line.length > NAMED_LINE_MAX || !links.length) continue;
    const prose = line.replace(/`[^`]*`/g, (code) => ' '.repeat(code.length));
    for (const [, label, url] of prose.matchAll(MD_LINKS)) {
      const t = parseTicketUrl(url!);
      const name = t && nameFrom(label!, t);
      if (t && name && !linked.has(t.ref)) linked.set(t.ref, name);
    }
    const urls = [...prose.matchAll(URLS)].map(([m]) => m.replace(/[.,;:!?*_~]+$/, ''));
    const t = urls.length === 1 && !prose.includes('](') ? parseTicketUrl(urls[0]!) : undefined;
    const name = t && !listed.has(t.ref) && nameOnLine(prose, urls[0]!, t);
    if (t && name) listed.set(t.ref, name);
  }
  return [...found.values()].map((t) => {
    const title = linked.get(t.ref) ?? listed.get(t.ref);
    return title ? { ...t, title } : t;
  });
}

/**
 * How a ticket is named on its own: its key or title, else what it is with the end of its id
 * ("Asana task …4821"), so untitled ones can be told apart.
 */
export function ticketLabel(t: Pick<LinkedTicket, 'provider' | 'kind' | 'key' | 'title' | 'url'>): string {
  if (t.provider === 'jira') return t.key ?? t.title ?? 'Jira issue';
  if (t.title ?? t.key) return (t.title ?? t.key)!;
  const what = t.kind === 'project' ? 'Asana project' : 'Asana task';
  const id = parseTicketUrl(t.url)?.ref.split(':').pop();
  return id ? `${what} …${id.slice(-4)}` : what;
}

/**
 * The note a person's turn carries to the orchestrator when it linked tickets it could not name:
 * their links, for link_ticket to title once it knows them. The UI leaves it out (stripTicketsNote).
 */
export function ticketsNote(urls: string[]): string {
  return `<tickets>\n${NOTE_LEAD}${urls.join(' ')}\n${NOTE_ASK}\n</tickets>`;
}

const NOTE_LEAD = 'Linked to this round-up without a title: ';
const NOTE_ASK = "Once you know a ticket's name, set it with link_ticket.";
/** Only the note exactly as ticketsNote writes it: a message of the person's own that ends in a `<tickets>` block stays. */
const TICKETS_NOTE = new RegExp(`\\n*<tickets>\\n${NOTE_LEAD}[^\\n]*\\n${NOTE_ASK.replace(/[.]/g, '\\.')}\\n</tickets>$`);

/** A turn's text without Kelpie's `<tickets>` note. */
export const stripTicketsNote = (text: string): string => text.replace(TICKETS_NOTE, '');

export const TICKET_PROVIDER_NAME: Record<TicketProvider, string> = { jira: 'Jira', asana: 'Asana' };
