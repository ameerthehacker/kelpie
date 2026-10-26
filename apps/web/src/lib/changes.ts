import type { AgentRef } from './review.js';

/** Mirrors the daemon's `ChangedFile`: one file in a diff. */
export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary: boolean;
  /** This file's chunk of a git unified diff; absent when binary or too large. */
  patch?: string;
  /** Too big to send with the rest: fetched on its own when asked for. */
  tooLarge?: boolean;
  /** Who changed it. */
  agents: AgentRef[];
}

/** Mirrors the daemon's `Changes`: what a round-up's feature branch, or one agent's branch, changed. */
export interface Changes {
  scope: 'feature' | 'agent';
  sessionId: string;
  roundUpId: string;
  /** none: no branch yet, a read-only agent, or Muster. */
  state: 'ready' | 'none';
  branch?: string;
  baseRef?: string;
  baseSha?: string;
  headSha?: string;
  /** The agent's diff includes work not yet committed. */
  dirty?: boolean;
  /** Where the branch is checked out, if it is (for "Open in VS Code"). */
  checkoutPath?: string;
  musteredFrom?: AgentRef[];
  rounds?: { index: number; state: 'mustered' | 'active'; baseSha: string; headSha: string }[];
  round?: number;
  stats: { files: number; additions: number; deletions: number };
  files: ChangedFile[];
}

/** `billing-api/package.json` → `billing-api/` and `package.json`. */
export function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { dir: '', base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

/** Files by directory, in the order the directories first appear. */
export function groupByDir<F extends Pick<ChangedFile, 'path'>>(files: readonly F[]): { dir: string; files: F[] }[] {
  const groups = new Map<string, F[]>();
  for (const f of files) {
    const { dir } = splitPath(f.path);
    const list = groups.get(dir);
    if (list) list.push(f);
    else groups.set(dir, [f]);
  }
  return [...groups].map(([dir, files]) => ({ dir, files }));
}

/** Where a file is in the list, and the files either side of it. */
export function neighbors<F extends Pick<ChangedFile, 'path'>>(files: readonly F[], path: string | undefined): { index: number; total: number; current?: F; prev?: F; next?: F } {
  const index = files.findIndex((f) => f.path === path);
  if (index < 0) return { index: -1, total: files.length };
  return { index, total: files.length, current: files[index], prev: files[index - 1], next: files[index + 1] };
}

export type StatSquare = 'add' | 'del' | 'none';

/**
 * GitHub's five squares: a change's additions and deletions in proportion. A side with any lines
 * gets at least one square; a file with no line changes (binary, a pure rename) gets none.
 */
export function statSquares(add: number, del: number): StatSquare[] {
  const total = add + del;
  if (total <= 0) return Array<StatSquare>(5).fill('none');
  let a = Math.round((add / total) * 5);
  if (add > 0 && a === 0) a = 1;
  if (del > 0 && a === 5) a = 4;
  return [...Array<StatSquare>(a).fill('add'), ...Array<StatSquare>(5 - a).fill('del')];
}

/**
 * The commit a comment's anchor names (`anchor.commitSha`): the head of the agent's round the person
 * picked, or `Changes.headSha` for the feature diff and for an agent's active or default round.
 */
export function anchorSha(changes: Pick<Changes, 'headSha' | 'rounds'> | undefined, selectedRound?: number): string | undefined {
  const r = selectedRound === undefined ? undefined : changes?.rounds?.find((x) => x.index === selectedRound);
  return r && r.state !== 'active' ? r.headSha : changes?.headSha;
}

/** "1 file", "185 files". */
export const filesLabel = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

/** "Mustered from 1 agent's branch", "Mustered from 2 agents' branches". */
export const musteredFromLabel = (n: number) => `Mustered from ${n} ${n === 1 ? "agent's branch" : "agents' branches"}`;

/** The agents, listed once each, that changed any of these files. */
export function agentsOf(files: readonly Pick<ChangedFile, 'agents'>[]): AgentRef[] {
  const seen = new Map<string, AgentRef>();
  for (const f of files) for (const a of f.agents) seen.set(a.id ?? `:${a.title}`, a);
  return [...seen.values()];
}

/** A link that opens a file in VS Code, when the branch is checked out somewhere. */
export const vscodeUrl = (checkoutPath: string | undefined, path: string) =>
  checkoutPath ? `vscode://file/${checkoutPath.replace(/^\/+|\/+$/g, '')}/${path}` : undefined;

/**
 * A unified diff's gutter label, old and new line numbers side by side as GitHub shows them: a
 * removed line has only its old number, an added one only its new, a context line both. Each is
 * padded to `width` so the columns line up in a monospace font.
 */
export function gutterNumbers(type: string | null, line: number, altLine: number | undefined, width: number): string {
  const pad = (n?: number) => (n === undefined ? '' : String(n)).padStart(width, ' ');
  if (type === 'change-deletion') return `${pad(line)} ${pad()}`;
  if (type === 'change-addition') return `${pad()} ${pad(line)}`;
  return `${pad(altLine ?? line)} ${pad(line)}`;
}
