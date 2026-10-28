import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import pLimit from 'p-limit';
import { DOCUMENT_MAX_BYTES, type ArtifactAuthor, type ArtifactDocument, type ArtifactDocumentBody, type Artifacts as ArtifactList } from '@kelpie/protocol';
import type { Store } from '@kelpie/store';
import type { Session } from './sessions.js';
import { runGit } from './worktrees.js';

/** How many documents a round-up lists, newest first. */
const MAX_DOCUMENTS = 200;
/** How much of a document is read for its title. */
const HEAD_BYTES = 4096;
/** Files stat'd or opened at once while listing: well under the open-file limit. */
const CONCURRENCY = 16;
const MARKDOWN = new Set(['.md', '.markdown']);
/** The person's own files in the scratch folder: not something an agent produced. */
const UPLOADS = 'uploads';
/** Folders never walked: dependencies, not documents. Hidden ones are skipped too. */
const SKIPPED = new Set(['node_modules']);

/** Why a document can't be served or accepted, with the HTTP status to answer with. */
export class ArtifactError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

/** A document's title: its first Markdown heading, else its file name. */
export function titleOf(head: string, path: string): string {
  const m = head.match(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/m);
  return m?.[1]?.trim() || basename(path, extname(path));
}

const skipped = (name: string) => name.startsWith('.') || SKIPPED.has(name);

/** A path in the scratch folder that may be a document: Markdown, not an upload, nothing hidden. */
export const isDocument = (rel: string) => {
  const parts = rel.split(sep);
  return MARKDOWN.has(extname(rel).toLowerCase()) && parts[0] !== UPLOADS && !parts.some((p) => skipped(p) || p === '..');
};

/** The Markdown files under `scratch`, relative to it: no uploads, and no hidden or dependency folders walked. */
async function documentsIn(scratch: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(scratch, rel), { withFileTypes: true }).catch(() => []);
    const dirs: string[] = [];
    for (const e of entries) {
      if (skipped(e.name) || (!rel && e.name === UPLOADS)) continue;
      const path = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) dirs.push(path);
      else if (e.isFile() && isDocument(path)) out.push(path);
    }
    for (const d of dirs) await walk(d);
  };
  await walk('');
  return out;
}

async function readHead(file: FileHandle, bytes: number): Promise<{ text: string; truncated: boolean }> {
  const buf = Buffer.alloc(bytes + 1);
  const { bytesRead } = await file.read(buf, 0, bytes + 1, 0);
  return { text: buf.subarray(0, Math.min(bytesRead, bytes)).toString('utf8'), truncated: bytesRead > bytes };
}

/** The listed time of a document's last change: its mtime, to the millisecond. */
const updatedAtOf = (info: Stats) => Math.round(info.mtimeMs);

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
    const limit = pLimit(CONCURRENCY);
    // Every candidate's time first (a stat each), then the newest only are opened for their titles.
    const found = scratch ? await documentsIn(scratch) : [];
    const stats = await Promise.all(found.map((rel) => limit(() => stat(join(scratch!, rel)).then((info) => ({ rel, info }), () => undefined))));
    const newest = stats
      .filter((s) => !!s && s.info.isFile())
      .sort((a, b) => b!.info.mtimeMs - a!.info.mtimeMs || a!.rel.localeCompare(b!.rel))
      .slice(0, MAX_DOCUMENTS);
    const authors = this.authors(roundUp, agents);
    const docs = await Promise.all(
      newest.map((s) =>
        limit(async () => {
          const file = await open(join(scratch!, s!.rel), 'r').catch(() => undefined);
          if (!file) return undefined;
          try {
            return this.describe(scratch!, s!.rel, s!.info, (await readHead(file, HEAD_BYTES)).text, authors, accepted);
          } catch {
            return undefined;
          } finally {
            await file.close();
          }
        }),
      ),
    );
    return { documents: docs.filter((d) => !!d), accepted: Object.fromEntries(accepted), heads: await this.heads(roundUp, agents) };
  }

  /**
   * One document with its text. `path` is relative to the scratch folder. Only a regular file with
   * one link, opened without following a link, that is still the file the checked path names: no
   * link (soft or hard) in the folder serves a file from outside it.
   */
  async document(roundUp: Session, agents: Session[], path: string): Promise<ArtifactDocumentBody> {
    const { scratch, rel, real } = await this.resolve(roundUp, path);
    const file = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
    if (!file) throw new ArtifactError('no such document', 404);
    try {
      const info = await file.stat();
      const checked = await lstat(real).catch(() => undefined);
      if (!info.isFile() || info.nlink !== 1 || !checked || checked.dev !== info.dev || checked.ino !== info.ino) throw new ArtifactError('no such document', 404);
      const { text, truncated } = await readHead(file, DOCUMENT_MAX_BYTES);
      const doc = this.describe(scratch, rel, info, text, this.authors(roundUp, agents), this.store.acceptedArtifacts(roundUp.id));
      return { ...doc, file: real, text, ...(truncated ? { truncated } : {}) };
    } finally {
      await file.close();
    }
  }

  /**
   * The person accepted an artifact (an `artifactKey`). A document only as they saw it: `seen` is
   * the `updatedAt` it was shown at, and a document changed since is refused (409), so a rewrite
   * that lands while they read is never accepted unseen. An agent's changes not while it works:
   * they are still moving.
   */
  async accept(roundUp: Session, agents: Session[], key: string, seen?: number, now = Date.now()): Promise<number> {
    if (key.startsWith('doc:')) {
      const { real } = await this.resolve(roundUp, key.slice(4));
      const info = await stat(real).catch(() => undefined);
      if (!info?.isFile()) throw new ArtifactError('no such document', 404);
      if (seen !== updatedAtOf(info)) throw new ArtifactError('it changed since you opened it: look over the new version, then accept it', 409);
    } else {
      const agentId = key.slice('changes:'.length, key.lastIndexOf('@'));
      if (agents.find((a) => a.id === agentId)?.working) throw new ArtifactError('the agent is still working on these changes: accept them once it is done', 409);
    }
    return this.store.acceptArtifact(roundUp.id, key, now);
  }

  /** A document's path checked: Markdown in the scratch folder, and there through any links. */
  private async resolve(roundUp: Session, path: string): Promise<{ scratch: string; rel: string; real: string }> {
    const scratch = roundUp.scratch;
    if (!scratch) throw new ArtifactError('this round-up has no scratch folder', 404);
    const rel = relative(scratch, join(scratch, path));
    if (!rel || rel.startsWith('..') || !isDocument(rel)) throw new ArtifactError('path must name a Markdown file in the scratch folder', 400);
    // Through links too: a link in the folder must not serve a file from outside it.
    const real = await realpath(join(scratch, rel)).catch(() => undefined);
    const root = await realpath(scratch).catch(() => scratch);
    if (!real || relative(root, real).startsWith('..')) throw new ArtifactError('no such document', 404);
    return { scratch, rel, real };
  }

  /**
   * Each writer agent's branch tip now, by id (else its latest delivery's): whether an Accept of its
   * changes (kept by commit) still holds. One `git for-each-ref` per repo, however many agents.
   */
  private async heads(roundUp: Session, agents: Session[]): Promise<Record<string, string>> {
    const ids = new Set(agents.map((a) => a.id));
    const rows = this.store.worktreesOf(roundUp.id).filter((w) => w.kind === 'agent' && ids.has(w.sessionId));
    if (!rows.length) return {};
    const out: Record<string, string> = {};
    for (const d of this.store.deliveriesOf(roundUp.id)) if (d.sessionId && ids.has(d.sessionId)) out[d.sessionId] = d.tipCommit;
    const byRepo = new Map<string, typeof rows>();
    for (const w of rows) byRepo.set(w.repoRoot, [...(byRepo.get(w.repoRoot) ?? []), w]);
    await Promise.all(
      [...byRepo].map(async ([repo, ws]) => {
        const r = await runGit(repo, ['for-each-ref', '--format=%(objectname) %(refname)', ...ws.map((w) => `refs/heads/${w.branch}`)]);
        if (r.code !== 0) return;
        const tips = new Map(r.stdout.split('\n').flatMap((l) => (l ? [[l.slice(l.indexOf(' ') + 1), l.slice(0, l.indexOf(' '))] as const] : [])));
        for (const w of ws) {
          const tip = tips.get(`refs/heads/${w.branch}`);
          if (tip) out[w.sessionId] = tip;
        }
      }),
    );
    return out;
  }

  /** Who last wrote each file in the scratch folder, by absolute path. */
  private authors(roundUp: Session, agents: Session[]): Map<string, ArtifactAuthor> {
    const out = new Map<string, ArtifactAuthor>();
    if (!roundUp.scratch) return out;
    const byId = new Map([roundUp, ...agents].map((s) => [s.id, s]));
    for (const w of this.store.lastWritesUnder([...byId.keys()], roundUp.scratch, [...MARKDOWN])) {
      const s = byId.get(w.sessionId)!;
      out.set(
        w.path,
        s === roundUp ? { kind: 'orchestrator', title: 'Kelpie', harness: s.harness } : { kind: 'agent', agentId: s.id, title: s.title, harness: s.harness },
      );
    }
    return out;
  }

  private describe(scratch: string, rel: string, info: Stats, head: string, authors: Map<string, ArtifactAuthor>, accepted: Map<string, number>): ArtifactDocument {
    const author = authors.get(join(scratch, rel));
    const updatedAt = updatedAtOf(info);
    const at = accepted.get(`doc:${rel}`);
    return {
      path: rel,
      title: titleOf(head, rel),
      ...(author ? { author } : {}),
      size: info.size,
      updatedAt,
      ...(at !== undefined && at >= updatedAt ? { acceptedAt: at } : {}),
    };
  }
}
