import type { EventOf, KelpieEvent, TodoItem, ToolCategory } from '@kelpie/protocol';

export interface ToolView {
  type: 'tool';
  callId: string;
  name: string;
  category: ToolCategory;
  title: string;
  input: unknown;
  state: 'running' | 'done' | 'error';
  output?: string;
  delta?: { added: number; removed: number };
  /** One-line summaries of what a sub-agent spawned by this call did. */
  steps: string[];
}

export type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | ToolView
  | { type: 'todos'; items: TodoItem[] }
  | { type: 'notice'; tone: 'error' | 'info'; text: string };

export type ChatItem =
  | { role: 'user'; id: string; text: string }
  | { role: 'assistant'; id: string; parts: AssistantPart[] };

/**
 * Folds a session's KEF events into chat items: user turns, and one
 * assistant item per stretch of agent activity between them. Pure, so the
 * UI can recompute it from the event log on every update.
 */
export function buildChat(events: readonly KelpieEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, ToolView>();

  const assistant = (id: string): AssistantPart[] => {
    const last = items.at(-1);
    if (last?.role === 'assistant') return last.parts;
    const parts: AssistantPart[] = [];
    items.push({ role: 'assistant', id, parts });
    return parts;
  };

  for (const ev of events) {
    if (ev.parentCallId) {
      subAgentStep(tools.get(ev.parentCallId), ev);
      continue;
    }
    switch (ev.kind) {
      case 'message':
        if (ev.data.role === 'user') items.push({ role: 'user', id: ev.id, text: ev.data.text });
        else assistant(ev.id).push({ type: 'text', text: ev.data.text });
        break;
      case 'thinking':
        // Claude Code withholds thinking text; an empty block has nothing to show.
        if (!ev.data.redacted) assistant(ev.id).push({ type: 'reasoning', text: ev.data.text });
        break;
      case 'tool.started': {
        if (ev.data.category === 'todo') break; // the `todos` snapshot shows the effect
        const view: ToolView = { type: 'tool', ...ev.data, state: 'running', steps: [] };
        tools.set(view.callId, view);
        assistant(ev.id).push(view);
        break;
      }
      case 'tool.finished': {
        const view = tools.get(ev.data.callId);
        if (!view) break;
        view.state = ev.data.ok ? 'done' : 'error';
        view.output = ev.data.truncated ? `${ev.data.output}\n…` : ev.data.output;
        break;
      }
      case 'file.changed': {
        const view = tools.get(ev.data.callId);
        if (view) view.delta = { added: ev.data.added, removed: ev.data.removed };
        break;
      }
      case 'todos': {
        const parts = assistant(ev.id);
        const existing = parts.find((p) => p.type === 'todos');
        if (existing) existing.items = ev.data.items;
        else parts.push({ type: 'todos', items: ev.data.items });
        break;
      }
      case 'turn.ended':
        if (ev.data.status === 'failed') assistant(ev.id).push({ type: 'notice', tone: 'error', text: ev.data.error ?? 'The turn failed.' });
        if (ev.data.status === 'interrupted') assistant(ev.id).push({ type: 'notice', tone: 'info', text: 'Interrupted.' });
        break;
      case 'process.exited':
        if (ev.data.code) {
          const detail = ev.data.stderrTail.trim().split('\n').slice(-3).join('\n');
          assistant(ev.id).push({ type: 'notice', tone: 'error', text: `Agent process exited with code ${ev.data.code}${detail ? `: ${detail}` : ''}` });
        }
        break;
    }
  }
  // Tools still open when the process is gone will never finish.
  if (events.at(-1)?.kind === 'process.exited') tools.forEach((t) => t.state === 'running' && (t.state = 'error'));
  return items;
}

function subAgentStep(parent: ToolView | undefined, ev: KelpieEvent): void {
  if (!parent || ev.kind !== 'tool.started') return;
  const { category, title } = (ev as EventOf<'tool.started'>).data;
  parent.steps.push(`${category} ${title}`);
}
