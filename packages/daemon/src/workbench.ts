import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import {
  DONE_FOR,
  workbenchPath,
  type CardCreate,
  type CardTicket,
  type CardUpdate,
  type EntryPatch,
  type ItemPatch,
  type WorkbenchAgentStatus,
  type WorkbenchCard,
  type WorkbenchEntry,
  type WorkbenchItem,
  type WorkbenchNote,
} from '@kelpie/protocol';
import type { CardRow, EntryRow, ItemRow, NoteRow, Store } from '@kelpie/store';
import { ToolError } from './errors.js';
import type { ManagerUpdate, Session, SessionManager } from './sessions.js';
import { GitError, localBranch, runGit, type LandResult, type Worktrees } from './worktrees.js';

/** How many of a card's latest notes it carries. */
const CARD_NOTES = 20;
/** Notes workbench_read shows besides those for the reader. */
const READ_NOTES = 8;
const NOTE_CHARS = 2000;
/** Rate limits on agents' and orchestrators' notes (the person has none): per recipient, and in all, per window. */
export const NOTE_WINDOW_MS = 10 * 60_000;
export const PAIR_LIMIT = 3;
export const SENDER_LIMIT = 12;
/** Live changes (an agent's status, approvals) go out at most this often per round-up. */
const PUBLISH_MS = 250;
export const WORKBENCH_TAG = 'kelpie-workbench';

/** Why the person's request on a card was refused, with the HTTP status to answer with. */
export class WorkbenchError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 500,
  ) {
    super(message);
  }
}

/** A card shows on the board: not removed by the person, and not done for over `DONE_FOR`. */
export const onBoard = (c: Pick<CardRow, 'archivedAt' | 'stage' | 'doneAt' | 'updatedAt'>, now: number) =>
  !c.archivedAt && !(c.stage === 'done' && now - (c.doneAt ?? c.updatedAt) > DONE_FOR);

/** `owner/name` from a remote's URL (`https://host/owner/name.git`, `git@host:owner/name`), or undefined (e.g. a local path). */
export function repoFromRemote(url: string): string | undefined {
  const u = url.trim();
  if (!/^[a-z][\w+.-]*:\/\//i.test(u) && !/^[^/\s]+:/.test(u)) return undefined;
  const m = u.match(/[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

const WILD = /[*?[{]/;
/** A claim as compared: lower case, no `./` or trailing slash, cut at its first wildcard. */
const stem = (claim: string) => {
  const n = claim.trim().replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
  const i = n.search(WILD);
  return (i < 0 ? n : n.slice(0, i)).replace(/\/+$/, '');
};

/**
 * Whether two claims may touch the same files: the same path or area, or one a directory (or glob)
 * that holds the other. `**` claims everything.
 */
export function claimsOverlap(a: string, b: string): boolean {
  const x = stem(a);
  const y = stem(b);
  if (!x || !y) return true;
  return x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`);
}

/** Keeps a `<kelpie-…>` tag in someone's text from opening or closing a block of the turn it goes into. */
const untag = (text: string) => text.replace(/<(\/?)(\s*)kelpie-/gi, '‹$1$2kelpie-');

/**
 * A note as its reader gets it: a header naming the sender, then the body quoted line by line, so no
 * line of it can pass for another note or a sender of its own.
 */
export const quoteNote = (n: Pick<NoteRow, 'fromTitle' | 'body'>) =>
  [`- From "${untag(n.fromTitle).replace(/\s+/g, ' ')}":`, ...untag(n.body).split(/\r?\n/).map((l) => `  > ${l}`)].join('\n');

const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** An agent's status, as its summary has it (see `Session.summary`). */
function statusOf(s: Session): WorkbenchAgentStatus {
  if (s.working) return s.approvals().length ? 'needs-approval' : 'working';
  if (s.halted !== undefined) return 'halted';
  if (s.limited) return 'paused';
  const t = s.lastTurn;
  return t === 'completed' ? 'done' : t === 'failed' ? 'failed' : t === 'interrupted' ? 'stopped' : 'idle';
}

const active = (status: WorkbenchAgentStatus) => status === 'working' || status === 'needs-approval';

const entryOf = (e: EntryRow): WorkbenchEntry => ({
  ...(e.focus ? { focus: e.focus } : {}),
  claims: e.claims,
  ...(e.blocker ? { blocker: e.blocker } : {}),
  ...(e.progress ? { progress: e.progress } : {}),
  updatedAt: e.updatedAt,
});

/** Someone with a say on the board: an agent, or a round-up's orchestrator. */
interface Party {
  session: Session;
  title: string;
}

/**
 * The Workbench: the person's board of features (cards, kept by orchestrators) and where agents say
 * what they are working on and leave each other notes. Everything is in the store; what Kelpie
 * derives (agents' status, approvals, merged) is read live as each card goes out.
 *
 * A note never starts a turn: one to someone is handed over with the next turn it gets anyway, or as
 * it reads the board. So notes can't set agents off answering each other in a loop; rate limits keep
 * any one sender from flooding the board.
 */
export class Workbench {
  private sessions: SessionManager | undefined;
  /** Each round-up's repo as cards show it, by cwd: resolved once (git), then read from here. */
  private readonly names = new Map<string, string>();
  private readonly naming = new Map<string, Promise<string>>();
  /** Each round-up's git remotes, by cwd, for the local branch a card lands on. */
  private readonly remotes = new Map<string, string[]>();
  /** Each repo's main checkout, by cwd, for finding other round-ups in the same repo. */
  private readonly roots = new Map<string, Promise<string>>();
  /** Every card id that exists, with its round-up: a deleted round-up's cards are gone from the store by the time it says so. */
  private readonly known = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Agents already seen: a writer new to Kelpie goes on its round-up's latest open card. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly worktrees?: Worktrees,
  ) {}

  attach(sessions: SessionManager): void {
    this.sessions = sessions;
    for (const c of this.store.cards()) this.known.set(c.id, c.roundUpId);
    for (const s of sessions.all()) this.seen.add(s.id);
    sessions.watch((u) => this.watch(u));
  }

  private get manager(): SessionManager {
    if (!this.sessions) throw new Error('the workbench is not attached to a session manager');
    return this.sessions;
  }

  // ── the board ────────────────────────────────────────────────────────

  /** Every card on the board, as the person sees it. */
  async board(now = Date.now()): Promise<WorkbenchCard[]> {
    const cards = this.store.cards().filter((c) => onBoard(c, now));
    await Promise.all([...new Set(cards.map((c) => c.roundUpId))].map((id) => this.nameOf(id)));
    return cards.map((c) => this.view(c));
  }

  card(id: string): WorkbenchCard | undefined {
    const row = this.store.card(id);
    return row && this.view(row);
  }

  /** The person takes a card off the board, or puts it back. */
  archive(id: string, archived: boolean): WorkbenchCard {
    const card = this.store.card(id);
    if (!card) throw new WorkbenchError('no such card', 404);
    const row = this.store.updateCard(id, { archivedAt: archived ? (card.archivedAt ?? Date.now()) : null })!;
    return this.send(row);
  }

  /**
   * Lands a card's work: its round-up's feature branch is merged into its base's local branch
   * (`landsOn`); nothing is pushed. Refused while the round-up has another open card (one feature
   * branch holds both), and, checked under the repo's lock so nothing starts meanwhile, while agents
   * work, writers' branches wait to be mustered, or the feature branch's worktree has uncommitted
   * changes. Once it lands the card is done and its agents' items merged.
   */
  async merge(id: string): Promise<WorkbenchCard> {
    const card = this.store.card(id);
    if (!card) throw new WorkbenchError('no such card', 404);
    const roundUp = this.manager.get(card.roundUpId);
    const home = this.store.worktreeOf(card.roundUpId);
    const worktrees = this.worktrees;
    if (!roundUp || !home || !worktrees || !roundUp.baseBranch) {
      throw new WorkbenchError('nothing to merge yet: no writing agent has worked on this feature’s branch', 409);
    }
    const now = Date.now();
    const others = this.store.cards(roundUp.id).filter((c) => c.id !== id && onBoard(c, now) && c.stage !== 'done');
    if (others.length) {
      throw new WorkbenchError(
        `${others.map((c) => `“${c.title}”`).join(', ')} ${others.length === 1 ? 'is' : 'are'} on the same feature branch, so merging would land ${others.length === 1 ? 'its' : 'their'} work too: finish or remove ${others.length === 1 ? 'it' : 'them'} first`,
        409,
      );
    }
    // Under the repo's lock: no muster can merge into the feature branch between these checks and the landing.
    const check = async (): Promise<string | undefined> => {
      const busy = this.manager.children(roundUp.id).filter((c) => c.working);
      if (busy.length) return `${busy.map((b) => `“${b.title}”`).join(', ')} ${busy.length === 1 ? 'is' : 'are'} still working: merge once they are done`;
      const waiting: string[] = [];
      for (const row of this.store.worktreesOf(roundUp.id)) {
        if (row.kind !== 'agent' || row.deliver !== 'muster' || row.state === 'mustered') continue;
        if ((await worktrees.ownCommits(row)) > 0 && !(await worktrees.isMerged(row.repoRoot, row.branch, home.branch))) {
          waiting.push(this.manager.get(row.sessionId)?.title ?? row.branch);
        }
      }
      if (waiting.length) return `${waiting.map((t) => `“${t}”`).join(', ')} ${waiting.length === 1 ? 'isn’t' : 'aren’t'} in the feature branch yet: ask Kelpie to muster first`;
      const now = this.store.worktreeOf(roundUp.id) ?? home;
      if (existsSync(now.path) && (await worktrees.dirty(now.path))) return 'the feature branch’s worktree has uncommitted changes: ask Kelpie to commit or muster them first';
      return undefined;
    };
    let landed: LandResult;
    try {
      landed = await worktrees.land(home.repoRoot, home.branch, roundUp.baseBranch, `Merge ${home.branch}: ${card.title}`, check);
    } catch (err) {
      if (err instanceof GitError) throw new WorkbenchError(`git failed while merging: ${err.message}`, 500);
      throw err;
    }
    if (!landed.ok) throw new WorkbenchError(landed.error, 409);
    const at = Date.now();
    const row = this.store.atomically(() => {
      // Only its agents' work landed here: other items (PRs elsewhere) keep what the orchestrator said.
      for (const item of this.store.itemsOf([id])) if (item.agentId && item.status !== 'closed') this.store.upsertItem(id, { key: item.key, status: 'merged' }, at);
      return this.store.updateCard(id, { stage: 'done', doneAt: card.stage === 'done' ? card.doneAt : at, archivedAt: null }, at)!;
    });
    return this.send(row);
  }

  // ── the orchestrator's cards ─────────────────────────────────────────

  /** `create_card`: a new card for one feature of the round-up. */
  async create(parent: Session, input: CardCreate): Promise<ToolCard> {
    const now = Date.now();
    // Without tickets of its own, a card carries the round-up's.
    const tickets: CardTicket[] = input.tickets ?? parent.tickets().map(({ source: _s, addedAt: _a, ...t }) => t);
    const row = this.store.atomically(() => {
      const card = this.store.createCard({ roundUpId: parent.id, title: input.title, stage: input.stage ?? 'building', callout: input.callout ?? null, tickets }, now);
      return { ...card, moved: this.applyItems(parent, card.id, input.items ?? [], now) };
    });
    this.known.set(row.id, parent.id);
    await this.nameOf(parent.id);
    this.resend(row.moved);
    return toolCard(this.send(this.store.card(row.id)!));
  }

  /** `update_card`: changes only the fields given. */
  async update(parent: Session, input: CardUpdate): Promise<ToolCard> {
    const card = this.store.card(input.card);
    if (!card || card.roundUpId !== parent.id) throw new ToolError(`no such card in this round-up: ${input.card}. workbench_read lists your cards with their ids.`);
    const now = Date.now();
    const stage = input.stage;
    let moved: string[] = [];
    const row = this.store.atomically(() => {
      moved = this.applyItems(parent, card.id, input.items ?? [], now);
      return this.store.updateCard(
        card.id,
        {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.callout !== undefined ? { callout: input.callout } : {}),
          ...(input.tickets ? { tickets: input.tickets } : {}),
          // Done is stamped when the card gets there; any other stage brings a removed card back.
          ...(stage ? { stage, doneAt: stage === 'done' ? (card.stage === 'done' ? card.doneAt : now) : null, ...(stage !== 'done' ? { archivedAt: null } : {}) } : {}),
        },
        now,
      )!;
    });
    await this.nameOf(parent.id);
    this.resend(moved);
    return toolCard(this.send(row));
  }

  /** Cards an agent's item left: they go out again as they are now. */
  private resend(cardIds: string[]): void {
    for (const id of cardIds) {
      const card = this.store.card(id);
      if (card) this.send(card);
    }
  }

  /**
   * Upserts and removes a card's items. An agent of the round-up is on one card at a time: its item
   * on any other of the round-up's cards goes. Returns the ids of the cards it left.
   */
  private applyItems(parent: Session, cardId: string, items: ItemPatch[], now: number): string[] {
    if (!items.length) return [];
    const moved = new Set<string>();
    const existing = new Set(this.store.itemsOf([cardId]).map((i) => i.key));
    for (const p of items) {
      if (p.remove) {
        this.store.removeItem(cardId, p.key);
        continue;
      }
      // Its writer item, when the key is one of this round-up's agents.
      const agent = this.manager.get(p.key);
      const own = agent?.parentId === parent.id ? agent : undefined;
      this.store.upsertItem(
        cardId,
        {
          key: p.key,
          ...(p.title !== undefined ? { title: p.title } : !existing.has(p.key) && own ? { title: own.title } : {}),
          ...(p.ref !== undefined ? { ref: p.ref } : {}),
          ...(p.url !== undefined ? { url: p.url } : {}),
          ...(p.status ? { status: p.status } : {}),
          ...(own ? { agentId: own.id } : {}),
        },
        now,
      );
      if (!own) continue;
      const theirs = new Set(this.store.cards(parent.id).map((c) => c.id));
      for (const other of this.store.itemsOfAgent(own.id)) {
        if (other.cardId === cardId || !theirs.has(other.cardId)) continue;
        this.store.removeItem(other.cardId, other.key);
        moved.add(other.cardId);
      }
    }
    return [...moved];
  }

  // ── agents' entries and notes ────────────────────────────────────────

  /** `workbench_update`: sets the agent's own entry, and puts it on its round-up's card if it isn't on one. */
  async setEntry(agent: Session, patch: EntryPatch): Promise<string> {
    if (agent.role !== 'agent') throw new ToolError('only agents have an entry of their own on the Workbench');
    const now = Date.now();
    const entry = this.store.atomically(() => {
      const e = this.store.setEntry(agent.id, agent.roundUpId, patch, now);
      this.place(agent, now);
      return e;
    });
    this.changed(agent.roundUpId, true);
    const clashes = await this.clashes(agent, entry.claims);
    return [
      'Your entry on the Workbench is updated.',
      ...(clashes.length
        ? [
            '',
            'Heads-up: others claim some of the same files or areas. Check workbench_read and settle it (workbench_post) before you change them:',
            ...clashes.map((c) => `- ${c}`),
          ]
        : []),
    ].join('\n');
  }

  /**
   * `workbench_post` and the person's notes: a note on the round-up's board, maybe to one agent (by
   * title or id) or to the orchestrator. Agents and orchestrators are rate-limited.
   */
  post(from: Session | undefined, roundUpId: string, input: { note: string; to?: string | undefined; card?: string | undefined }): { note: NoteRow; delivery: string } {
    const roundUp = this.manager.get(roundUpId);
    if (!roundUp) throw new ToolError('no such round-up');
    const body = input.note.trim();
    if (!body) throw new ToolError('the note is empty');
    if (body.length > NOTE_CHARS) throw new ToolError(`a note can be at most ${NOTE_CHARS} characters; put long text in a file and point to it`);
    const to = input.to?.trim() ? this.party(roundUp, input.to.trim()) : undefined;
    if (to && from && to.session.id === from.id) throw new ToolError('that is you: a note to yourself goes nowhere');
    const now = Date.now();
    if (from) {
      const since = now - NOTE_WINDOW_MS;
      if (to && this.store.notesFromSince(from.id, since, to.session.id) >= PAIR_LIMIT) {
        throw new ToolError(
          `You have sent "${to.title}" ${PAIR_LIMIT} notes in the last ${NOTE_WINDOW_MS / 60_000} minutes. Wait for it to answer (an answer comes with your next turn, or shows in workbench_read), or carry on without it.`,
        );
      }
      if (this.store.notesFromSince(from.id, since) >= SENDER_LIMIT) {
        throw new ToolError(`You have posted ${SENDER_LIMIT} notes in the last ${NOTE_WINDOW_MS / 60_000} minutes, the most allowed. Carry on with your task; post again later only if you must.`);
      }
    }
    let cardId: string | null = null;
    if (input.card) {
      const card = this.store.card(input.card);
      if (!card || card.roundUpId !== roundUpId) throw new ToolError(`no such card in this round-up: ${input.card}`);
      cardId = card.id;
    } else cardId = this.cardFor(from, roundUpId, now)?.id ?? null;
    const note = this.store.addNote(
      {
        roundUpId,
        cardId,
        fromId: from?.id ?? null,
        fromKind: !from ? 'person' : from.role === 'orchestrator' ? 'orchestrator' : 'agent',
        fromTitle: from ? this.titleOf(from) : 'The person',
        toId: to?.session.id ?? null,
        toTitle: to?.title ?? null,
        body,
      },
      now,
    );
    this.changed(roundUpId, true);
    return { note, delivery: this.delivery(to) };
  }

  /** The person's note on a card, maybe to one of its round-up's agents (by id). */
  postByPerson(cardId: string, body: string, to?: string): WorkbenchCard {
    const card = this.store.card(cardId);
    if (!card) throw new WorkbenchError('no such card', 404);
    this.post(undefined, card.roundUpId, { note: body, to, card: cardId });
    return this.view(this.store.card(cardId)!);
  }

  /** What becomes of a note, for whoever posted it. */
  private delivery(to: Party | undefined): string {
    if (!to) return 'Posted to the board: everyone in this round-up sees it when they read the board.';
    if (to.session.role === 'orchestrator') return 'The orchestrator gets it with its next turn (e.g. when an agent goes idle), or as it reads the board.';
    return to.session.working
      ? `"${to.title}" is working: it gets your note with its next turn, or as soon as it reads the board. It is never interrupted for a note.`
      : `"${to.title}" is not working now: it gets your note when it next starts a turn. A note never starts one; the orchestrator decides whether it works again.`;
  }

  /**
   * Notes waiting for a session, to go with a turn Kelpie or the orchestrator sends it; marked as
   * handed over. Runs in that turn's transaction.
   */
  inbox(session: Session): string | undefined {
    const notes = this.store.undeliveredNotes(session.id);
    if (!notes.length) return undefined;
    this.store.markNotesDelivered(notes.map((n) => n.id));
    this.changed(session.roundUpId);
    return `<${WORKBENCH_TAG}>\nNotes for you on the Workbench:\n${notes.map(quoteNote).join('\n')}\n\nAnswer one with workbench_post only if it asks something of you; never just to acknowledge it.\n</${WORKBENCH_TAG}>`;
  }

  /** `workbench_read`: the round-up's cards and agents, others' claims in the same repo, and notes. Hands over the reader's notes. */
  async read(reader: Session): Promise<string> {
    const roundUp = this.manager.get(reader.roundUpId);
    if (!roundUp) throw new ToolError('no such round-up');
    const now = Date.now();
    const cards = this.store.cards(roundUp.id).filter((c) => onBoard(c, now));
    const agents = this.manager.children(roundUp.id);
    const entries = new Map(this.store.entriesOf([roundUp.id]).map((e) => [e.sessionId, e]));
    const items = this.store.itemsOf(cards.map((c) => c.id));
    const out: string[] = [`# Workbench of "${roundUp.title || 'Untitled'}"${reader.role === 'agent' ? ` (you are "${reader.title}")` : ''}`];

    const shown = new Set<string>();
    for (const card of cards) {
      out.push('', `## Card "${card.title}" · ${card.stage}${reader.role === 'orchestrator' ? ` · id ${card.id}` : ''}`);
      if (card.callout) out.push(`Callout: ${card.callout}`);
      const rows = items.filter((i) => i.cardId === card.id);
      if (!rows.length) out.push('(no items)');
      for (const item of rows) {
        const agent = item.agentId ? this.manager.get(item.agentId) : undefined;
        if (agent) shown.add(agent.id);
        out.push(...(agent ? this.agentLines(agent, entries.get(agent.id), reader, item) : [`- ${item.title} · ${item.status}${item.ref ? ` · ${item.ref}` : ''}`]));
      }
    }
    const rest = agents.filter((a) => !shown.has(a.id));
    const listed = rest.filter((a) => entries.has(a.id) || active(statusOf(a)) || a.id === reader.id);
    if (listed.length) {
      out.push('', cards.length ? '## Agents not on a card' : '## Agents');
      for (const a of listed) out.push(...this.agentLines(a, entries.get(a.id), reader));
    }
    if (rest.length > listed.length) out.push(`(${rest.length - listed.length} more agent${rest.length - listed.length === 1 ? ' is' : 's are'} idle with no entry)`);

    const others = await this.neighbours(roundUp);
    if (others.length) {
      out.push('', '## Working in the same repo, in other round-ups');
      for (const o of others) out.push(`- "${o.roundUp}" / "${o.agent}" · ${o.status} · claims: ${o.claims.join(', ')}`);
    }

    const mine = reader.role === 'agent' ? this.store.entriesOf([roundUp.id]).find((e) => e.sessionId === reader.id) : undefined;
    const clashes = mine ? await this.clashes(reader, mine.claims) : [];
    if (clashes.length) out.push('', '## Overlaps with your claims', ...clashes.map((c) => `- ${c}`));

    const waiting = this.store.undeliveredNotes(reader.id);
    if (waiting.length) {
      this.store.markNotesDelivered(waiting.map((n) => n.id), now);
      this.changed(roundUp.id);
      out.push('', '## Notes for you', ...waiting.map(quoteNote), 'Answer one with workbench_post only if it asks something of you.');
    }
    const fresh = new Set(waiting.map((n) => n.id));
    const recent = this.store.notesOf(roundUp.id, { limit: READ_NOTES + fresh.size }).filter((n) => !fresh.has(n.id)).slice(-READ_NOTES);
    if (recent.length) out.push('', '## Recent notes', ...recent.map((n) => `- "${clip(untag(n.fromTitle), 120)}"${n.toTitle ? ` → "${clip(untag(n.toTitle), 120)}"` : ''}: ${clip(untag(n.body), 300)}`));
    if (!cards.length && !listed.length && !recent.length) out.push('', 'Nothing on the board yet.');
    return out.join('\n');
  }

  private agentLines(a: Session, e: EntryRow | undefined, reader: Session, item?: ItemRow): string[] {
    const status = statusOf(a);
    const wt = this.store.worktreeOf(a.id);
    const head = [
      `- "${a.title}"${a.id === reader.id ? ' (you)' : ''}`,
      status,
      a.kind === 'muster' ? 'Muster' : a.writes ? `writer${wt ? ` on ${wt.branch}${wt.state === 'mustered' ? ' (mustered)' : ''}` : ''}` : 'read-only',
      ...(item && item.status !== 'draft' ? [`item ${item.status}`] : []),
    ].join(' · ');
    return [
      head,
      ...(e?.focus ? [`  focus: ${e.focus}`] : []),
      ...(e?.claims.length ? [`  claims: ${e.claims.join(', ')}`] : []),
      ...(e?.blocker ? [`  BLOCKED: ${e.blocker}`] : []),
      ...(e?.progress ? [`  progress: ${e.progress}`] : []),
    ];
  }

  /**
   * Who else claims what `agent` claims: agents of its own round-up whose claims still stand (see
   * `stillClaims`), and those working in other round-ups in its repo.
   */
  private async clashes(agent: Session, claims: string[]): Promise<string[]> {
    if (!claims.length) return [];
    const out: string[] = [];
    const overlap = (theirs: string[]) => theirs.filter((t) => claims.some((c) => claimsOverlap(c, t)));
    for (const e of this.store.entriesOf([agent.roundUpId])) {
      if (e.sessionId === agent.id) continue;
      const other = this.manager.get(e.sessionId);
      if (!other || !this.stillClaims(other)) continue;
      const hit = overlap(e.claims);
      if (hit.length) out.push(`"${other.title}" (${statusOf(other)}) claims ${hit.join(', ')}`);
    }
    const roundUp = this.manager.get(agent.roundUpId);
    for (const o of roundUp ? await this.neighbours(roundUp) : []) {
      const hit = overlap(o.claims);
      if (hit.length) out.push(`"${o.agent}" in round-up "${o.roundUp}" (${o.status}) claims ${hit.join(', ')}`);
    }
    return out;
  }

  /**
   * Whether an agent's claims still stand: while it works, and for a writer whose work is still to be
   * mustered (its branch has yet to meet the others'). A finished reader's, or mustered work's, don't.
   */
  private stillClaims(agent: Session): boolean {
    if (active(statusOf(agent))) return true;
    const wt = this.store.worktreeOf(agent.id);
    return agent.writes && wt?.deliver === 'muster' && wt.state !== 'mustered';
  }

  /** Agents working now with claims, in other round-ups in the same repo. */
  private async neighbours(roundUp: Session): Promise<{ roundUp: string; agent: string; status: WorkbenchAgentStatus; claims: string[] }[]> {
    const others = this.manager.all().filter((s) => !s.parentId && s.id !== roundUp.id);
    if (!others.length) return [];
    const entries = this.store.entriesOf(others.map((o) => o.id)).filter((e) => e.claims.length);
    if (!entries.length) return [];
    const root = await this.rootOf(roundUp.cwd);
    const out = [];
    for (const e of entries) {
      const agent = this.manager.get(e.sessionId);
      const theirs = this.manager.get(e.roundUpId);
      if (!agent || !theirs || !active(statusOf(agent)) || (await this.rootOf(theirs.cwd)) !== root) continue;
      out.push({ roundUp: theirs.title || 'Untitled', agent: agent.title, status: statusOf(agent), claims: e.claims });
    }
    return out;
  }

  /** An agent (by title or id) or the orchestrator ("orchestrator") of a round-up. */
  private party(roundUp: Session, name: string): Party {
    if (['orchestrator', 'kelpie'].includes(name.toLowerCase()) || name === roundUp.id) return { session: roundUp, title: 'Orchestrator' };
    const agents = this.manager.children(roundUp.id);
    const byId = agents.find((a) => a.id === name);
    if (byId) return { session: byId, title: byId.title };
    const want = name.replace(/^"|"$/g, '').trim().toLowerCase();
    const matches = agents.filter((a) => a.title.trim().toLowerCase() === want);
    if (matches.length === 1) return { session: matches[0]!, title: matches[0]!.title };
    // Several with that title: the one working, if only one is.
    const working = matches.filter((a) => a.working);
    if (working.length === 1) return { session: working[0]!, title: working[0]!.title };
    if (matches.length) throw new ToolError(`several agents are called "${name}"; pass one's id (list_agents or workbench_read)`);
    throw new ToolError(`no agent called "${name}" in this round-up. Its agents: ${agents.map((a) => `"${a.title}"`).join(', ') || 'none'}; or "orchestrator".`);
  }

  private titleOf(s: Session): string {
    return s.role === 'orchestrator' ? 'Orchestrator' : s.title;
  }

  /** A writer not on any of its round-up's cards goes on the latest open one, as an item keyed by its id. True if it did. */
  private place(agent: Session, now: number): boolean {
    if (!agent.writes || agent.kind !== 'worker') return false;
    const cards = this.store.cards(agent.roundUpId);
    const ids = new Set(cards.map((c) => c.id));
    if (this.store.itemsOfAgent(agent.id).some((i) => ids.has(i.cardId))) return false;
    const card = this.latestCard(cards, now);
    if (card) this.store.upsertItem(card.id, { key: agent.id, title: agent.title, agentId: agent.id }, now);
    return !!card;
  }

  /** The card a note goes on: the poster's own, else the round-up's latest on the board. */
  private cardFor(from: Session | undefined, roundUpId: string, now: number): CardRow | undefined {
    const cards = this.store.cards(roundUpId);
    if (from?.role === 'agent') {
      const ids = new Set(cards.map((c) => c.id));
      const own = this.store.itemsOfAgent(from.id).find((i) => ids.has(i.cardId));
      if (own) return cards.find((c) => c.id === own.cardId);
    }
    return this.latestCard(cards, now);
  }

  private latestCard(cards: CardRow[], now: number): CardRow | undefined {
    return cards.filter((c) => onBoard(c, now) && c.stage !== 'done').sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  // ── views ────────────────────────────────────────────────────────────

  private view(card: CardRow): WorkbenchCard {
    const roundUp = this.sessions?.get(card.roundUpId);
    const entries = new Map(this.store.entriesOf([card.roundUpId]).map((e) => [e.sessionId, e]));
    const items = this.store.itemsOf([card.id]).map((i) => this.itemView(i, entries.get(i.agentId ?? '')));
    const agents = [...new Set(items.flatMap((i) => (i.agentId ? [i.agentId] : [])))].flatMap((id) => this.sessions?.get(id) ?? []);
    const home = this.store.worktreeOf(card.roundUpId);
    const name = roundUp && this.names.get(roundUp.cwd);
    return {
      id: card.id,
      roundUpId: card.roundUpId,
      title: card.title,
      chat: roundUp?.title || 'Untitled',
      ...(name ? { repo: name } : {}),
      ...(home ? { branch: home.branch } : {}),
      ...(roundUp?.baseBranch ? { base: roundUp.baseBranch, landsOn: localBranch(roundUp.baseBranch, this.remotes.get(roundUp.cwd) ?? []) } : {}),
      stage: card.stage,
      ...(card.callout ? { callout: card.callout } : {}),
      tickets: card.tickets as CardTicket[],
      items,
      agents: { total: agents.length, working: agents.filter((a) => a.working).length },
      needsYou: agents.reduce((n, a) => n + a.approvals().length, 0),
      notes: this.store.notesOf(card.roundUpId, { cardId: card.id, limit: CARD_NOTES }).map((n) => this.noteView(n)),
      noteCount: this.store.noteCount(card.id),
      archived: !!card.archivedAt,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
      ...(card.doneAt ? { doneAt: card.doneAt } : {}),
    };
  }

  private itemView(i: ItemRow, e: EntryRow | undefined): WorkbenchItem {
    const agent = i.agentId ? this.sessions?.get(i.agentId) : undefined;
    const wt = i.agentId ? this.store.worktreeOf(i.agentId) : undefined;
    return {
      key: i.key,
      title: i.title,
      ...(i.ref ? { ref: i.ref } : {}),
      ...(i.url ? { url: i.url } : {}),
      // Kelpie knows when a writer's work is in the feature branch.
      status: wt?.state === 'mustered' && i.status !== 'closed' && i.status !== 'merged' ? 'merged' : i.status,
      ...(agent ? { agentId: agent.id, agentTitle: agent.title, harness: agent.info().harness, agentStatus: statusOf(agent) } : {}),
      ...(wt ? { branch: wt.branch } : {}),
      waiting: agent?.approvals().length ?? 0,
      ...(e ? { entry: entryOf(e) } : {}),
      updatedAt: Math.max(i.updatedAt, e?.updatedAt ?? 0),
    };
  }

  private noteView(n: NoteRow): WorkbenchNote {
    const from = n.fromId ? this.sessions?.get(n.fromId) : undefined;
    return {
      id: n.id,
      from: n.fromKind === 'agent' ? { kind: 'agent', title: n.fromTitle, ...(from ? { agentId: from.id, harness: from.info().harness } : {}) } : { kind: n.fromKind, title: n.fromTitle },
      ...(n.toTitle ? { to: { title: n.toTitle, ...(n.toId ? { agentId: n.toId } : {}) } } : {}),
      body: n.body,
      createdAt: n.createdAt,
      ...(n.deliveredAt ? { deliveredAt: n.deliveredAt } : {}),
    };
  }

  // ── live updates ─────────────────────────────────────────────────────

  /** Sends a card out now, as it is; returns its view. */
  private send(row: CardRow): WorkbenchCard {
    this.known.set(row.id, row.roundUpId);
    const card = this.view(row);
    this.sessions?.publish({ type: 'card', card });
    return card;
  }

  private watch(u: ManagerUpdate): void {
    if (u.type === 'agent') this.changed(u.agent.parentId);
    else if (u.type === 'approvals') this.changed(u.roundUpId);
    else if (u.type === 'session') {
      const s = u.session;
      if (s.parentId && !this.seen.has(s.id)) {
        this.seen.add(s.id);
        const agent = this.sessions?.get(s.id);
        if (agent && this.place(agent, Date.now())) return this.changed(s.parentId, true);
      }
      this.changed(s.parentId ?? s.id);
    }
    else if (u.type === 'deleted') {
      let roundUp = false;
      for (const [id, of] of this.known) {
        if (of !== u.id) continue;
        roundUp = true;
        this.known.delete(id);
        this.sessions?.publish({ type: 'card-removed', id });
      }
      // An agent went: its items lose it.
      if (!roundUp) for (const id of new Set(this.known.values())) this.changed(id);
    }
  }

  /** A round-up's cards may look different now: they go out again shortly (at once with `now`). */
  private changed(roundUpId: string, now = false): void {
    if (![...this.known.values()].includes(roundUpId)) return;
    if (now) {
      clearTimeout(this.timers.get(roundUpId));
      this.timers.delete(roundUpId);
      this.publishRoundUp(roundUpId);
      return;
    }
    if (this.timers.has(roundUpId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(roundUpId);
      this.publishRoundUp(roundUpId);
    }, PUBLISH_MS);
    timer.unref();
    this.timers.set(roundUpId, timer);
  }

  private publishRoundUp(roundUpId: string): void {
    try {
      const now = Date.now();
      for (const card of this.store.cards(roundUpId)) if (onBoard(card, now)) this.send(card);
    } catch (err) {
      console.error(`round-up ${roundUpId}: could not send its Workbench cards`, err);
    }
  }

  // ── repos ────────────────────────────────────────────────────────────

  /** The round-up's repo as its cards show it: `owner/name` from its origin remote, else its folder's name. */
  private nameOf(roundUpId: string): Promise<string | undefined> {
    const cwd = this.sessions?.get(roundUpId)?.cwd;
    if (!cwd) return Promise.resolve(undefined);
    const known = this.names.get(cwd);
    if (known) return Promise.resolve(known);
    let p = this.naming.get(cwd);
    if (!p) {
      p = (async () => {
        const root = await this.rootOf(cwd);
        const remote = await runGit(root, ['remote', 'get-url', 'origin']);
        const remotes = await runGit(root, ['remote']);
        this.remotes.set(cwd, remotes.code === 0 ? remotes.stdout.split('\n').filter(Boolean) : []);
        const name = (remote.code === 0 && repoFromRemote(remote.stdout)) || basename(root);
        this.names.set(cwd, name);
        return name;
      })();
      this.naming.set(cwd, p);
    }
    return p;
  }

  /** The main checkout of the repo `cwd` is in, or `cwd` itself outside git. */
  private rootOf(cwd: string): Promise<string> {
    let p = this.roots.get(cwd);
    if (!p) {
      p = (async () => (this.worktrees ? await this.worktrees.repoOf(cwd) : undefined) ?? cwd)();
      this.roots.set(cwd, p);
    }
    return p;
  }
}

/** A card as `create_card` and `update_card` answer: enough to check it, and its link for the person. */
export interface ToolCard {
  card: string;
  link: string;
  title: string;
  stage: WorkbenchCard['stage'];
  callout?: string;
  items: { key: string; title: string; status: WorkbenchItem['status']; agentStatus?: WorkbenchAgentStatus }[];
}

const toolCard = (c: WorkbenchCard): ToolCard => ({
  card: c.id,
  link: workbenchPath(c.id),
  title: c.title,
  stage: c.stage,
  ...(c.callout ? { callout: c.callout } : {}),
  items: c.items.map((i) => ({ key: i.key, title: i.title, status: i.status, ...(i.agentStatus ? { agentStatus: i.agentStatus } : {}) })),
});
