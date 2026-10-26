import { firstLine, type KelpieEvent, type TodoItem, type ToolCategory, type UsageLimitPause } from '@kelpie/protocol';

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
  /** Given the Claude in Chrome tools: it may drive the person's own browser. */
  browser: boolean;
  /**
   * `needs-approval`: working, but waiting on the person to allow something. `paused`: stopped at the
   * usage limit, until it resets. `halted`: the person stopped it ("Stop all") until they resume it.
   */
  status: 'working' | 'needs-approval' | 'halted' | 'paused' | 'done' | 'failed' | 'stopped' | 'idle';
  /** While `paused`: when the limit resets and Kelpie resumes it. */
  limited?: UsageLimitPause;
  /** Not working, but in line to resume (after a restart, or the person's "Resume all") once the agent limit has room. */
  queued?: boolean;
  /** One line on what it is doing, or what it last said. */
  now: string;
  /** When `now` is a tool call ("Read src/a.ts"): which tool, so a client can put it in its own words without parsing `now`. */
  nowTool?: { name: string; category: ToolCategory };
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

export type Now = Pick<AgentSummary, 'now' | 'nowTool'>;

const said = (now: string | undefined): Now | undefined => (now ? { now } : undefined);

/** What an event says the agent is doing now, if anything. Sub-agent chatter is not its own. */
export function nowOf(e: KelpieEvent): Now | undefined {
  if (e.parentCallId) return undefined;
  switch (e.kind) {
    case 'tool.started': {
      const { name, category, title } = e.data;
      return category === 'todo' ? undefined : { now: clip(`${name} ${title}`.trim()), nowTool: { name, category } };
    }
    case 'message':
      return e.data.role === 'assistant' ? said(firstLine(e.data.text, NOW_CHARS)) : undefined;
    case 'turn.ended':
      return said(e.data.status === 'failed' ? clip(`Failed: ${e.data.error ?? 'unknown error'}`) : e.data.status === 'interrupted' ? 'Stopped.' : undefined);
    default:
      return undefined;
  }
}

/** Kinds that can change what the pane shows for an agent. */
export const SUMMARY_KINDS = new Set<KelpieEvent['kind']>(['session.started', 'activity', 'todos', 'tool.started', 'message', 'turn.ended', 'permission.requested', 'permission.resolved']);
