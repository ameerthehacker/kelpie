import { z } from 'zod';

/**
 * Artifacts: what a round-up's agents produced for the person to look at, on its Artifacts tab.
 *
 * Documents are the Markdown files in the round-up's scratch folder (not the person's uploads),
 * each credited to whoever last wrote it there, as its log shows. Pull requests are the
 * deliverables on the round-up's Workbench cards (`WorkbenchItem`), and code changes an agent's
 * diff (`/changes`); both come from their own endpoints.
 *
 * `GET /api/sessions/:id/artifacts` (a round-up's, or an agent's for its round-up) answers with
 * `Artifacts`; `GET /api/sessions/:id/artifacts/document?path=` with one `ArtifactDocumentBody`;
 * `POST /api/sessions/:id/artifacts/accept` (`ArtifactAccept`) records the person's Accept and
 * answers with `Artifacts`, or 409 when what they saw has moved on. `/api/events` sends an
 * `artifacts` event (`ArtifactsChanged`) whenever a file in a round-up's scratch folder is written.
 */

/** Who last wrote a document: one of the round-up's agents, or its orchestrator (Kelpie). */
export interface ArtifactAuthor {
  kind: 'agent' | 'orchestrator';
  /** The agent's id; absent for the orchestrator. */
  agentId?: string;
  title: string;
  harness: string;
}

/** A Markdown file in the round-up's scratch folder. */
export interface ArtifactDocument {
  /** Relative to the scratch folder, e.g. `notes/migration.md`. */
  path: string;
  /** Its first heading, else its file name. */
  title: string;
  /** Absent when no write of it is in any log (e.g. it was written from a shell). */
  author?: ArtifactAuthor;
  size: number;
  /** Epoch ms of its last change on disk. */
  updatedAt: number;
  /** When the person accepted it; absent while it is ready for review (never accepted, or changed since). */
  acceptedAt?: number;
}

export interface Artifacts {
  /** Newest first. */
  documents: ArtifactDocument[];
  /** Every artifact the person accepted, by key (`artifactKey`), with when (epoch ms). */
  accepted: Record<string, number>;
  /**
   * Each writer agent's commit now, by its id (its branch's tip, else its latest delivery's): an
   * Accept of its changes at another commit no longer holds.
   */
  heads: Record<string, string>;
}

/** The `artifacts` event: an agent or the orchestrator wrote `path` (relative) in the round-up's scratch folder. */
export interface ArtifactsChanged {
  roundUpId: string;
  path: string;
}

/** One document with its text, cut at `DOCUMENT_MAX_BYTES` (`truncated`). */
export interface ArtifactDocumentBody extends ArtifactDocument {
  /** Where it is on disk (for "Open in VS Code"). */
  file: string;
  text: string;
  truncated?: boolean;
}

/** The largest part of a document the API sends. */
export const DOCUMENT_MAX_BYTES = 1024 * 1024;

/** An artifact the side panel can open: a document, or an agent's code changes. */
export type ArtifactRef = { kind: 'document'; path: string } | { kind: 'changes'; agentId: string };

/**
 * The key an Accept is stored by: a document's path, or an agent's changes at the commit they were
 * accepted at (new commits make them ready for review again).
 */
export const artifactKey = (ref: ArtifactRef, headSha?: string) =>
  ref.kind === 'document' ? `doc:${ref.path}` : `changes:${ref.agentId}@${headSha ?? ''}`;

/**
 * Body of `POST /api/sessions/:id/artifacts/accept`. A document's Accept says which version the
 * person saw (`seen`: its `updatedAt`); a newer one is refused.
 */
export const ArtifactAccept = z
  .object({
    key: z.string().regex(/^(doc:.+|changes:[^@]+@[0-9a-f]{4,64})$/).max(4200),
    seen: z.number().int().nonnegative().optional(),
  })
  .refine((b) => !b.key.startsWith('doc:') || b.seen !== undefined, { message: "a document's Accept needs the updatedAt the person saw (seen)" });
export type ArtifactAccept = z.infer<typeof ArtifactAccept>;
