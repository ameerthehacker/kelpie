import { firstLine, type AgentUpdate, type ArtifactDocument, type ArtifactRef, type Artifacts } from '@kelpie/protocol';
import type { AgentSummary } from './agents.js';
import { paneKey } from './artifacts.js';
import type { ChatItem } from './chat.js';
import { planGroup } from './status.js';

/**
 * Where an agent stands in its round-up's progress, as the Progress card and the agent chips mark
 * it: the design's four (done, needs you, working, queued), and failed or stopped, which it has no
 * mark for but which must not vanish. Paused at the usage limit, or not started yet, is queued.
 */
export type ProgressState = 'needs-you' | 'failed' | 'working' | 'queued' | 'stopped' | 'done';

/** Most urgent first: the footer's counts, and the bar's segments past the cap. */
export const PROGRESS_ORDER: ProgressState[] = ['done', 'needs-you', 'failed', 'working', 'queued', 'stopped'];

export const PROGRESS_LABEL: Record<ProgressState, string> = {
  'needs-you': 'Needs you',
  failed: 'Failed',
  working: 'Working',
  queued: 'Queued',
  stopped: 'Stopped',
  done: 'Done',
};

/** A failure stays one, even once the orchestrator has moved on: it never delivered. */
export function progressState(a: AgentSummary): ProgressState {
  if (a.status === 'failed') return 'failed';
  switch (planGroup(a)) {
    case 'needs-you':
      return 'needs-you';
    case 'working':
      return 'working';
    case 'paused':
      return 'queued';
    case 'stopped':
      return a.status === 'idle' || a.queued ? 'queued' : 'stopped';
    case 'to-merge':
    case 'done':
      return 'done';
    default:
      return 'stopped';
  }
}

/** One finished agent's work, or a document left for the person, as "Ready for you" lists it. */
export interface Deliverable {
  /** Its row's key: the artifact's `paneKey`, or the agent's id for a report. */
  key: string;
  /** What its row opens in the side panel; absent for a report, which opens its agent. */
  ref?: ArtifactRef;
  /** The agent it is from; absent for Kelpie's own documents. */
  agentId?: string;
  title: string;
  harness?: string;
  /** A writer's branch, a read-only agent's report, or a document in the scratch folder. */
  kind: 'changes' | 'report' | 'document';
  /** Its meta line after the kind: "+7 −1 · 3 files", the report's first line, or who wrote the document. */
  detail?: string;
  /** `review`: its branch waits to be mustered. */
  state: 'review' | 'merged' | 'done';
  /** Epoch ms it finished. */
  at: number;
}

export const DELIVERABLE_STATE: Record<Deliverable['state'], string> = { review: 'Ready for review', merged: 'Merged', done: 'Done' };

export interface Segment {
  state: ProgressState;
  /** How many agents it stands for (1, until the bar is past its cap). */
  size: number;
  /** The agent's title, when it stands for one. */
  title?: string;
}

export interface Progress {
  total: number;
  done: number;
  counts: Record<ProgressState, number>;
  /** One per agent in the order they started; past `maxSegments`, one per state, sized by its count. */
  segments: Segment[];
  /** Epoch ms of the latest change to any agent. */
  lastChange: number;
  /** Finished work, newest first. */
  ready: Deliverable[];
  /** The line under it all: who is still working, and what else is left. */
  footer: { text: string; tone: ProgressState };
  /** Nothing left working, waiting or queued. */
  finished: boolean;
}

export const MAX_SEGMENTS = 48;
const NAMED = 2;

const list = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** "A is", "A and B are", "A, B and 3 others are". */
function subject(titles: string[]): string {
  const named = titles.slice(0, NAMED);
  const rest = titles.length - named.length;
  const names = rest ? [...named, `${rest} other${rest === 1 ? '' : 's'}`] : named;
  return `${list.format(names)} ${titles.length === 1 ? 'is' : 'are'}`;
}

const counted = (s: ProgressState, n: number) => (s === 'needs-you' ? `${n} need${n === 1 ? 's' : ''} you` : `${n} ${PROGRESS_LABEL[s].toLowerCase()}`);

/** "+7 −1 · 3 files", from what its last report said it changed. */
export function changeStat(files: AgentUpdate['filesChanged']): string | undefined {
  if (!files?.length) return undefined;
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return `+${added} −${removed} · ${files.length} file${files.length === 1 ? '' : 's'}`;
}

function deliverable(a: AgentSummary, update: AgentUpdate | undefined): Deliverable {
  const kind = a.writes && a.branch ? 'changes' : 'report';
  const detail = kind === 'changes' ? changeStat(update?.filesChanged) : update?.report ? firstLine(update.report, 80) : undefined;
  const state = a.worktree === 'mustered' ? 'merged' : planGroup(a) === 'to-merge' ? 'review' : 'done';
  const ref = kind === 'changes' ? ({ kind: 'changes', agentId: a.id } as const) : undefined;
  return { key: ref ? paneKey(ref) : a.id, ...(ref ? { ref } : {}), agentId: a.id, title: a.title, harness: a.harness, kind, ...(detail ? { detail } : {}), state, at: a.updatedAt };
}

function documentDeliverable(d: ArtifactDocument): Deliverable {
  const ref = { kind: 'document', path: d.path } as const;
  const by = d.author?.kind === 'agent' ? d.author : undefined;
  return {
    key: paneKey(ref),
    ref,
    ...(by?.agentId ? { agentId: by.agentId } : {}),
    title: d.title,
    ...(d.author ? { harness: d.author.harness } : {}),
    kind: 'document',
    detail: by?.title ?? 'Kelpie',
    state: 'review',
    at: d.updatedAt,
  };
}

/**
 * Whether the person accepted an agent's changes. Accepts are kept by the commit they were made at,
 * which the agent list doesn't carry, so an Accept at any commit counts: a done agent's work only
 * moves on when it is resumed.
 */
const changesAccepted = (accepted: Artifacts['accepted'], agentId: string) => Object.keys(accepted).some((k) => k.startsWith(`changes:${agentId}@`));

/**
 * The round-up's progress, from its agents as they are now (not from the updates piled up in the
 * chat); `updates`, each agent's latest report, only fills in what its work was. `artifacts`: its
 * documents join "Ready for you", and what the person accepted leaves it. Pure.
 */
export function progressOf(
  agents: readonly AgentSummary[],
  updates: ReadonlyMap<string, AgentUpdate> = new Map(),
  artifacts?: Artifacts,
  maxSegments = MAX_SEGMENTS,
): Progress {
  const ordered = [...agents].sort((a, b) => a.createdAt - b.createdAt);
  const states = ordered.map(progressState);
  const counts = Object.fromEntries(PROGRESS_ORDER.map((s) => [s, 0])) as Record<ProgressState, number>;
  for (const s of states) counts[s]++;

  const segments: Segment[] =
    ordered.length <= maxSegments
      ? ordered.map((a, i) => ({ state: states[i]!, size: 1, title: a.title }))
      : PROGRESS_ORDER.flatMap((state) => (counts[state] ? [{ state, size: counts[state] }] : []));

  const accepted = artifacts?.accepted ?? {};
  const ready = [
    ...ordered.filter((a, i) => states[i] === 'done' && !changesAccepted(accepted, a.id)).map((a) => deliverable(a, updates.get(a.id))),
    ...(artifacts?.documents ?? []).filter((d) => !d.acceptedAt).map(documentDeliverable),
  ].sort((a, b) => b.at - a.at);

  const working = ordered.filter((_, i) => states[i] === 'working').map((a) => a.title);
  const others = (['needs-you', 'failed', 'queued', 'stopped'] as const).flatMap((s) => (counts[s] ? [counted(s, counts[s])] : []));
  const finished = !working.length && !counts['needs-you'] && !counts.queued;
  const footer: Progress['footer'] = working.length
    ? { text: [`${subject(working)} still working`, ...others].join(' · '), tone: 'working' }
    : finished && !counts.failed && !counts.stopped
      ? { text: agents.length === 1 ? 'The agent finished' : 'All agents finished', tone: 'done' }
      : { text: (finished ? ['Nothing left working', ...others] : others).join(' · '), tone: counts['needs-you'] ? 'needs-you' : finished && counts.failed ? 'failed' : 'queued' };

  return {
    total: agents.length,
    done: counts.done,
    counts,
    segments,
    lastChange: agents.reduce((t, a) => Math.max(t, a.updatedAt), 0),
    ready,
    footer,
    finished,
  };
}

/** Where the chat shows its Progress card, and what the agents last reported. */
export interface ChatProgress {
  /** The chat item it sits in: the latest to start agents or hear from them. */
  anchor?: string;
  updates: Map<string, AgentUpdate>;
}

/**
 * The one place in the chat the Progress card goes: after the latest agents started or reported
 * on, so it is near the end while there is news, and never repeated. Each agent's latest report
 * comes along for its "Ready for you" row. Pure.
 */
export function chatProgress(items: readonly ChatItem[]): ChatProgress {
  const updates = new Map<string, AgentUpdate>();
  let anchor: string | undefined;
  for (const item of items) {
    if (item.role !== 'assistant') continue;
    for (const part of item.parts) {
      if (part.type === 'agents') {
        anchor = item.id;
        for (const a of part.agents) updates.set(a.agentId, a);
      } else if (part.type === 'spawn' && part.state !== 'error') anchor = item.id;
    }
  }
  return { ...(anchor ? { anchor } : {}), updates };
}
