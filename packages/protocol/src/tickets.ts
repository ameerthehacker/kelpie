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

/** A ticket as a round-up lists it. */
export const LinkedTicket = z.object({
  provider: TicketProvider,
  kind: TicketKind,
  /** Where it opens: a Jira issue's `/browse/KEY` page, or the Asana link as it was shared. */
  url: z.string(),
  /** A Jira issue's key (`SHOP-412`); Asana links carry none. */
  key: z.string().optional(),
  /** A readable name, once the orchestrator has given one (e.g. the Asana project's). */
  title: z.string().optional(),
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

/**
 * Every Jira or Asana ticket linked in a piece of text, first mention first, each once. Bare keys
 * ("SHOP-412") are left alone: without a link there is no telling where they live. Pure.
 */
export function findTickets(text: string): TicketLink[] {
  const found = new Map<string, TicketLink>();
  for (const [match] of text.matchAll(URLS)) {
    // Sentence punctuation and markdown emphasis after a link are not part of it.
    const t = parseTicketUrl(match.replace(/[.,;:!?*_~]+$/, ''));
    if (t && !found.has(t.ref)) found.set(t.ref, t);
  }
  return [...found.values()];
}

/** How a ticket is named on its own: its key or title, else what it is ("Asana task"). */
export function ticketLabel(t: Pick<LinkedTicket, 'provider' | 'kind' | 'key' | 'title'>): string {
  if (t.provider === 'jira') return t.key ?? t.title ?? 'Jira issue';
  return t.title ?? t.key ?? (t.kind === 'project' ? 'Asana project' : 'Asana task');
}

export const TICKET_PROVIDER_NAME: Record<TicketProvider, string> = { jira: 'Jira', asana: 'Asana' };
