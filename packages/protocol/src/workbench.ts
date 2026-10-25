import { z } from 'zod';

/**
 * Workbench: the person's board of features. A round-up's orchestrator creates a card per feature
 * it takes on (`create_card`) and keeps each current (`update_card`); one round-up can have
 * several. Kelpie derives the live parts (agents, approvals, merged) itself.
 */

/** The card's column: Blocked, Building, In review, Ready to merge, Done. Set by the orchestrator. */
export const Stage = z.enum(['blocked', 'building', 'review', 'ready', 'done']);
export type Stage = z.infer<typeof Stage>;

/** Where one deliverable stands. `merged` is set by Kelpie when the writer's worktree is mustered. */
export const ItemStatus = z.enum(['draft', 'checks', 'review', 'approved', 'merged', 'blocked', 'closed']);
export type ItemStatus = z.infer<typeof ItemStatus>;

/** A ticket the person named for this work, shown as a chip on the card. */
export const Ticket = z.object({
  /** As the tracker shows it: `PROJ-142`, `#88`. */
  key: z.string().min(1).max(40),
  system: z.enum(['jira', 'asana', 'linear', 'github', 'other']),
  title: z.string().max(200).optional(),
  url: z.url().optional(),
});
export type Ticket = z.infer<typeof Ticket>;

/** A change to one item, upserted by `key`. Only the fields given change. */
export const ItemPatch = z.object({
  /** An agent's id in this round-up (its writer item), or a short name the orchestrator picks. */
  key: z.string().min(1).max(80),
  title: z.string().min(1).max(160).optional(),
  /** A short reference shown on the row, e.g. a PR number (`#412`); `null` clears it. */
  ref: z.string().max(20).nullable().optional(),
  /** `null` clears it. */
  url: z.url().nullable().optional(),
  status: ItemStatus.optional(),
  /** Drop this item from the card. */
  remove: z.boolean().optional(),
});
export type ItemPatch = z.infer<typeof ItemPatch>;

/** The `update_card` input: changes only the fields given. */
export const CardPatch = z.object({
  /** The outcome in a few words. */
  title: z.string().min(1).max(120).optional(),
  stage: Stage.optional(),
  /** One line on what the round-up needs from the person; `null` clears it. */
  callout: z.string().max(280).nullable().optional(),
  /** Replaces the card's tickets. */
  tickets: z.array(Ticket).max(20).optional(),
  /** Upserted by key; items not named are left alone. */
  items: z.array(ItemPatch).max(200).optional(),
});
export type CardPatch = z.infer<typeof CardPatch>;

/** The `create_card` input: a patch with a title. The tool answers with the new card. */
export const CardCreate = CardPatch.extend({ title: z.string().min(1).max(120) });
export type CardCreate = z.infer<typeof CardCreate>;

/** The `update_card` input: which card, and the fields to change. */
export const CardUpdate = CardPatch.extend({
  /** The card's id. */
  card: z.string().min(1),
});
export type CardUpdate = z.infer<typeof CardUpdate>;

/** An agent's status as the UI groups it (the daemon's agent summary). */
export type WorkbenchAgentStatus = 'working' | 'needs-approval' | 'done' | 'failed' | 'stopped' | 'idle';

/** One deliverable on a card, as the person sees it. */
export interface WorkbenchItem {
  key: string;
  title: string;
  ref?: string;
  url?: string;
  /** As the orchestrator set it, except `merged` once the writer's worktree is mustered. */
  status: ItemStatus;
  /** The sub-agent behind the item; links it into the card's agent and approval counts. */
  agentId?: string;
  /** The writer's own branch. */
  branch?: string;
  /** The writer's live status. */
  agentStatus?: WorkbenchAgentStatus;
  /** Open approvals the writer is waiting on. */
  waiting: number;
  /** Epoch ms. */
  updatedAt: number;
}

/** One feature's card, as the person sees it: what is stored plus what Kelpie derives live. */
export interface WorkbenchCard {
  /** Assigned by the daemon (a uuid). */
  id: string;
  /** The round-up (chat) the card came from; it can have several cards. */
  roundUpId: string;
  title: string;
  /** That round-up's (chat's) title. */
  chat: string;
  /** `owner/name` from the repo's origin remote, else the cwd's folder name. */
  repo?: string;
  /** The git branch this card's work lands on. */
  branch?: string;
  /** The branch it will be merged into. */
  base?: string;
  stage: Stage;
  callout?: string;
  tickets: Ticket[];
  items: WorkbenchItem[];
  /** The agents linked to this card's items: all of them, and those working now. */
  agents: { total: number; working: number };
  /** Open approvals of the agents linked to this card's items. */
  needsYou: number;
  /** The person removed it from the board; it comes back when the stage moves off `done`. */
  archived: boolean;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms of the last stored change. */
  updatedAt: number;
}

/** Body of `PATCH /api/workbench/:cardId`, which answers with the card (or 404). */
export const CardArchive = z.object({ archived: z.boolean() });
export type CardArchive = z.infer<typeof CardArchive>;

/** `card-removed`: the card is gone (e.g. its round-up was deleted). */
export interface CardRemoved {
  /** The card's id. */
  id: string;
}

/** The Workbench's events on `/api/events`, by SSE event name, with their JSON payloads. */
export interface WorkbenchEvents {
  /** Snapshot on connect: every card not archived. */
  workbench: WorkbenchCard[];
  /** A card changed (or was created). */
  card: WorkbenchCard;
  'card-removed': CardRemoved;
}
