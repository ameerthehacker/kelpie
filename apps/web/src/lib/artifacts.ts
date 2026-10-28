import { artifactKey, type ArtifactDocument, type ArtifactRef, type Artifacts, type ItemStatus, type WorkbenchCard, type WorkbenchItem } from '@kelpie/protocol';

/** `['artifacts', roundUpId]`: a round-up's documents and Accepts; the event stream invalidates it. */
export const ARTIFACTS = 'artifacts';
export const artifactsKey = (roundUpId: string | undefined) => [ARTIFACTS, roundUpId] as const;
/** `['artifacts', roundUpId, 'document', path]`: one document's text. */
export const documentKey = (roundUpId: string, path: string) => [ARTIFACTS, roundUpId, 'document', path] as const;

/** An open artifact's tab in the agent pane. Agents' tabs are their ids (uuids), so these never clash. */
export const paneKey = (ref: ArtifactRef) => (ref.kind === 'document' ? `doc:${ref.path}` : `changes:${ref.agentId}`);

/** The tab key back as the artifact it opens, or undefined for an agent's tab. */
export function refOfKey(key: string): ArtifactRef | undefined {
  if (key.startsWith('doc:')) return { kind: 'document', path: key.slice(4) };
  if (key.startsWith('changes:')) return { kind: 'changes', agentId: key.slice(8) };
  return undefined;
}

/** A document's file name: `db/README.md` → `README.md`. */
export const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** A pull request on the Artifacts tab: a deliverable on one of the round-up's Workbench cards. */
export interface PullRequest {
  item: WorkbenchItem;
  card: WorkbenchCard;
}

/** What the person should look at first: their reviews, then what is stuck, then what is moving. */
const RANK: Record<ItemStatus, number> = { review: 0, blocked: 1, checks: 2, draft: 3, approved: 4, merged: 5, closed: 6 };

/**
 * The round-up's pull requests across its cards, by `RANK`, then the newest. Only items with a link
 * or a ref (`#482`): Kelpie puts each writer on its card as an item too, which is no pull request.
 */
export function pullRequestsOf(cards: readonly WorkbenchCard[] | undefined, roundUpId: string): PullRequest[] {
  const out: PullRequest[] = [];
  for (const card of cards ?? []) if (card.roundUpId === roundUpId) for (const item of card.items) if (item.url || item.ref) out.push({ item, card });
  return out.sort((a, b) => RANK[a.item.status] - RANK[b.item.status] || b.item.updatedAt - a.item.updatedAt);
}

const SUMMARY: [ItemStatus, string][] = [
  ['review', 'needs your review'],
  ['blocked', 'blocked'],
  ['checks', 'checks running'],
  ['draft', 'draft'],
  ['approved', 'approved'],
  ['merged', 'merged'],
  ['closed', 'closed'],
];

const counts = (prs: readonly PullRequest[]) =>
  SUMMARY.flatMap(([s, label]) => {
    const n = prs.filter((p) => p.item.status === s).length;
    return n ? [`${n} ${label}`] : [];
  });

/**
 * The line beside "Pull requests": "1 needs your review · 1 draft · 1 merged" for those shown, then,
 * for any not shown, "(56 more · 39 merged · 11 needs your review · 6 blocked)".
 */
export function prSummary(prs: readonly PullRequest[], shown = prs.length): string {
  const head = counts(prs.slice(0, shown)).join(' · ');
  const rest = prs.slice(shown);
  if (!rest.length) return head;
  return `${head} (${[`${rest.length} more`, ...counts(rest)].join(' · ')})`;
}

/** The Artifacts tab's count: documents and pull requests; none (no pill) when there are neither. */
export const artifactCount = (documents: readonly ArtifactDocument[] | undefined, prs: readonly PullRequest[]) => {
  const n = (documents?.length ?? 0) + prs.length;
  return n || undefined;
};

/**
 * Whether the person accepted an agent's changes as they are now: at its current commit (`heads`).
 * Without one (its branch is gone), an Accept at any commit counts.
 */
export function changesAccepted({ accepted, heads }: Pick<Artifacts, 'accepted' | 'heads'>, agentId: string): boolean {
  const head = heads[agentId];
  return head ? accepted[artifactKey({ kind: 'changes', agentId }, head)] !== undefined : Object.keys(accepted).some((k) => k.startsWith(`changes:${agentId}@`));
}

/** "Open on GitHub" for a GitHub link, else "Open link". */
export const linkLabel = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '') === 'github.com' ? 'Open on GitHub' : 'Open link';
  } catch {
    return 'Open link';
  }
};

/** The turn Approve sends the round-up's orchestrator, which owns the card and moves the item on. */
export const approveTurn = ({ item, card }: PullRequest) =>
  `I approve “${item.title}”${item.ref ? ` (${item.ref})` : ''} on “${card.title}”. Move it on.`;

/** The message "Ask for changes" sends the artifact's author, naming what it is about. */
export function askTurn(about: { kind: 'document'; file: string } | { kind: 'changes' }, text: string): string {
  return about.kind === 'document' ? `About your document ${about.file}: ${text}` : `About your code changes: ${text}`;
}
