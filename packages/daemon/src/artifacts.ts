import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { DOCUMENT_MAX_BYTES, type ArtifactAuthor, type ArtifactDocument, type ArtifactDocumentBody, type Artifacts as ArtifactList } from '@kelpie/protocol';
import type { Store } from '@kelpie/store';
import type { Session } from './sessions.js';

/** How many documents a round-up lists, newest first. */
const MAX_DOCUMENTS = 200;
/** How much of a document is read for its title. */
const HEAD_BYTES = 4096;
const MARKDOWN = new Set(['.md', '.markdown']);
/** The person's own files in the scratch folder: not something an agent produced. */
const UPLOADS = 'uploads';

/** Why a document can't be served, with the HTTP status to answer with. */
export class ArtifactError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
  }
}

/** A document's title: its first Markdown heading, else its file name. */
export function titleOf(head: string, path: string): string {
  const m = head.match(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/m);
  return m?.[1]?.trim() || basename(path, extname(path));
}

/** A path in the scratch folder that may be a document: Markdown, not an upload, nothing hidden. */
const isDocument = (rel: string) => {
  const parts = rel.split(sep);
  return MARKDOWN.has(extname(rel).toLowerCase()) && parts[0] !== UPLOADS && !parts.some((p) => p.startsWith('.') || p === '..');
};

async function readHead(path: string, bytes: number): Promise<{ text: string; truncated: boolean }> {
  const file = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes + 1);
    const { bytesRead } = await file.read(buf, 0, bytes + 1, 0);
    return { text: buf.subarray(0, Math.min(bytesRead, bytes)).toString('utf8'), truncated: bytesRead > bytes };
  } finally {
    await file.close();
  }
}

/**
 * A round-up's artifacts on disk: the Markdown files its orchestrator and agents left in its
 * scratch folder, each credited to whoever last wrote it there (its `file.changed` events), and
 * the person's Accepts (`artifact_reviews`).
 */
export class Artifacts {
  constructor(private readonly store: Store) {}

  /** The round-up's documents, newest first, and what the person accepted. `agents` are its sub-agents. */
  async list(roundUp: Session, agents: Session[]): Promise<ArtifactList> {
    const accepted = this.store.acceptedArtifacts(roundUp.id);
    const scratch = roundUp.scratch;
    const entries = scratch ? await readdir(scratch, { recursive: true, withFileTypes: true }).catch(() => []) : [];
    const paths = entries.filter((e) => e.isFile()).map((e) => relative(scratch!, join(e.parentPath, e.name))).filter(isDocument);
    const authors = this.authors(roundUp, agents);
    const docs = await Promise.all(paths.map((p) => this.describe(scratch!, p, authors, accepted).catch(() => undefined)));
    const documents = docs.filter((d) => !!d).sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
    return { documents: documents.slice(0, MAX_DOCUMENTS), accepted: Object.fromEntries(accepted) };
  }

  /** One document with its text. `path` is relative to the scratch folder. */
  async document(roundUp: Session, agents: Session[], path: string): Promise<ArtifactDocumentBody> {
    const scratch = roundUp.scratch;
    if (!scratch) throw new ArtifactError('this round-up has no scratch folder', 404);
    const rel = relative(scratch, join(scratch, path));
    if (!rel || rel.startsWith('..') || !isDocument(rel)) throw new ArtifactError('path must name a Markdown file in the scratch folder', 400);
    // Through links too: a link in the folder must not serve a file from outside it.
    const real = await realpath(join(scratch, rel)).catch(() => undefined);
    const root = await realpath(scratch).catch(() => scratch);
    if (!real || relative(root, real).startsWith('..')) throw new ArtifactError('no such document', 404);
    const doc = await this.describe(scratch, rel, this.authors(roundUp, agents), this.store.acceptedArtifacts(roundUp.id)).catch(() => undefined);
    if (!doc) throw new ArtifactError('no such document', 404);
    const { text, truncated } = await readHead(real, DOCUMENT_MAX_BYTES);
    return { ...doc, text, ...(truncated ? { truncated } : {}) };
  }

  /** The person accepted an artifact (an `artifactKey`). */
  accept(roundUp: Session, key: string, now = Date.now()): number {
    return this.store.acceptArtifact(roundUp.id, key, now);
  }

  /** Who last wrote each file in the scratch folder, by absolute path. */
  private authors(roundUp: Session, agents: Session[]): Map<string, ArtifactAuthor> {
    const out = new Map<string, ArtifactAuthor>();
    if (!roundUp.scratch) return out;
    const byId = new Map([roundUp, ...agents].map((s) => [s.id, s]));
    for (const w of this.store.lastWritesUnder([...byId.keys()], roundUp.scratch)) {
      const s = byId.get(w.sessionId)!;
      out.set(
        w.path,
        s === roundUp ? { kind: 'orchestrator', title: 'Kelpie', harness: s.harness } : { kind: 'agent', agentId: s.id, title: s.title, harness: s.harness },
      );
    }
    return out;
  }

  private async describe(scratch: string, rel: string, authors: Map<string, ArtifactAuthor>, accepted: Map<string, number>): Promise<ArtifactDocument | undefined> {
    const abs = join(scratch, rel);
    const info = await stat(abs);
    if (!info.isFile()) return undefined;
    const { text } = await readHead(abs, HEAD_BYTES);
    const author = authors.get(abs);
    const updatedAt = Math.round(info.mtimeMs);
    const at = accepted.get(`doc:${rel}`);
    return {
      path: rel,
      title: titleOf(text, rel),
      ...(author ? { author } : {}),
      size: info.size,
      updatedAt,
      ...(at !== undefined && at >= updatedAt ? { acceptedAt: at } : {}),
    };
  }
}
