import { firstLine, type KelpieEvent, type TodoItem } from '@kelpie/protocol';

/**
 * A sub-agent at a glance, for the agent pane: kept current from its events, so listing
 * an orchestrator's agents never reads their logs.
 */
export interface AgentSummary {
  id: string;
  parentId: string;
  title: string;
  harness: string;
  /** The model the harness reports, once it has started. */
  model: string | undefined;
  writes: boolean;
  status: 'working' | 'done' | 'failed' | 'stopped' | 'idle';
  /** One line on what it is doing, or what it last said. */
  now: string;
  /** Its own todo list, from its own session. */
  todos: TodoItem[];
  /** Ordinary work, or Muster. */
  kind: 'worker' | 'muster';
  /** A writer's own branch; whether its work is to be mustered (or is standalone); and whether its worktree is on disk or mustered. */
  branch?: string;
  deliver?: 'muster' | 'standalone';
  worktree?: 'creating' | 'active' | 'mustered' | 'removed';
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
}

const NOW_CHARS = 160;

const clip = (s: string) => (s.length > NOW_CHARS ? `${s.slice(0, NOW_CHARS - 1)}…` : s);

/** What an event says the agent is doing now, if anything. Sub-agent chatter is not its own. */
export function nowOf(e: KelpieEvent): string | undefined {
  if (e.parentCallId) return undefined;
  switch (e.kind) {
    case 'tool.started':
      return e.data.category === 'todo' ? undefined : clip(`${e.data.name} ${e.data.title}`.trim());
    case 'message':
      return e.data.role === 'assistant' ? firstLine(e.data.text, NOW_CHARS) || undefined : undefined;
    case 'turn.ended':
      return e.data.status === 'failed' ? clip(`Failed: ${e.data.error ?? 'unknown error'}`) : e.data.status === 'interrupted' ? 'Stopped.' : undefined;
    default:
      return undefined;
  }
}

/** Kinds that can change what the pane shows for an agent. */
export const SUMMARY_KINDS = new Set<KelpieEvent['kind']>(['session.started', 'activity', 'todos', 'tool.started', 'message', 'turn.ended']);
