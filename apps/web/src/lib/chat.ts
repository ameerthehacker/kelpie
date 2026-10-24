import type { AgentUpdate, EventOf, KelpieEvent, TodoItem, ToolCategory } from '@kelpie/protocol';

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
  /** A sub-agent the orchestrator started (or tried to). */
  | SpawnView
  /** Sub-agents Kelpie told the orchestrator about. */
  | { type: 'agents'; agents: AgentUpdate[] }
  | { type: 'notice'; tone: 'error' | 'info'; text: string };

export interface SpawnView {
  type: 'spawn';
  callId: string;
  title: string;
  state: 'running' | 'done' | 'error';
  /** Known once the call returns. */
  agentId?: string;
  /** Why it was refused. */
  error?: string;
}

const SPAWN_TOOL = 'mcp__kelpie__spawn_agent';

export type ChatItem =
  | { role: 'user'; id: string; text: string }
  | { role: 'assistant'; id: string; parts: AssistantPart[] };

const NOTIFICATION_OPEN = '<kelpie-notification>';
const AGENT_HEADER = /^## Agent "(.*)" \(([^)]*)\) is idle: turn (.+)$/gm;

/**
 * The agents in a notification's text. Only for logs written before echoes carried
 * `agents` (and `source`); the daemon now attaches both.
 */
export function agentsFromText(text: string): AgentUpdate[] {
  const body = text.replace(/\n*This message is from Kelpie[^]*$/, '').replace(/\n*<\/kelpie-notification>\s*$/, '');
  const headers = [...body.matchAll(AGENT_HEADER)];
  return headers.map((m, i) => {
    const end = headers[i + 1]?.index ?? body.length;
    let rest = body.slice(m.index + m[0].length, end).replace(/^\n/, '');
    let error: string | undefined;
    for (;;) {
      const line = /^(Error|Files changed): (.*)\n?/.exec(rest);
      if (!line) break;
      if (line[1] === 'Error') error = line[2];
      rest = rest.slice(line[0].length);
    }
    const report = rest.trim().replace(/\n?\(report cut; read_agent has all of it\)$/, '');
    return { agentId: m[2]!, title: m[1]!, status: m[3]!.trim(), report: report === '(no report)' ? '' : report, ...(error ? { error } : {}) };
  });
}

/**
 * A turn Kelpie sent the orchestrator itself: agent updates, or a note (a restart) as one line.
 * The echo's `agents` leave out a report the text already carries in full.
 */
function kelpieTurn(data: EventOf<'message'>['data']): AssistantPart {
  const parsed = agentsFromText(data.text);
  const agents = data.agents?.map((a) => ({ ...a, report: a.report ?? parsed.find((p) => p.agentId === a.agentId)?.report ?? '' })) ?? parsed;
  if (agents.length) return { type: 'agents', agents };
  const note = data.text.replace(NOTIFICATION_OPEN, '').trim().split('\n')[0] ?? '';
  return { type: 'notice', tone: 'info', text: note };
}

/** Kelpie's own turns. Logs from before echoes carried `source` only have the tag to go by. */
const fromKelpie = (data: EventOf<'message'>['data']) =>
  data.source === 'kelpie' || (data.source === undefined && data.sent === true && data.text.startsWith(NOTIFICATION_OPEN));

/**
 * Folds a session's KEF events into chat items: user turns, and one
 * assistant item per stretch of agent activity between them. Pure, so the
 * UI can recompute it from the event log on every update.
 */
export function buildChat(events: readonly KelpieEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, ToolView>();
  const spawns = new Map<string, SpawnView>();

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
        // Turns Kelpie sent itself (notifications, restarts) are not the person speaking.
        if (ev.data.role === 'user' && fromKelpie(ev.data)) assistant(ev.id).push(kelpieTurn(ev.data));
        else if (ev.data.role === 'user') items.push({ role: 'user', id: ev.id, text: ev.data.text });
        else assistant(ev.id).push({ type: 'text', text: ev.data.text });
        break;
      case 'thinking':
        // Claude Code withholds thinking text; an empty block has nothing to show.
        if (!ev.data.redacted) assistant(ev.id).push({ type: 'reasoning', text: ev.data.text });
        break;
      case 'tool.started': {
        // Todo lists live in the agent pane, by agent, not scattered through the chat.
        if (ev.data.category === 'todo') break;
        if (ev.data.name === SPAWN_TOOL) {
          const input = (ev.data.input ?? {}) as { title?: unknown };
          const view: SpawnView = { type: 'spawn', callId: ev.data.callId, title: typeof input.title === 'string' ? input.title : 'Agent', state: 'running' };
          spawns.set(view.callId, view);
          assistant(ev.id).push(view);
          break;
        }
        const view: ToolView = { type: 'tool', ...ev.data, state: 'running', steps: [] };
        tools.set(view.callId, view);
        assistant(ev.id).push(view);
        break;
      }
      case 'tool.finished': {
        const spawn = spawns.get(ev.data.callId);
        if (spawn) settleSpawn(spawn, ev.data.ok, ev.data.output);
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
      case 'turn.ended':
        if (ev.data.status === 'failed') assistant(ev.id).push({ type: 'notice', tone: 'error', text: ev.data.error ?? 'The turn failed.' });
        if (ev.data.status === 'interrupted') assistant(ev.id).push({ type: 'notice', tone: 'info', text: 'Interrupted.' });
        break;
      case 'process.exited':
        // Tools still open when the process is gone will never finish, even if a later run resumes the session.
        tools.forEach((t) => t.state === 'running' && (t.state = 'error'));
        spawns.forEach((s) => s.state === 'running' && (s.state = 'error'));
        if (ev.data.code) {
          const detail = ev.data.stderrTail.trim().split('\n').slice(-3).join('\n');
          assistant(ev.id).push({ type: 'notice', tone: 'error', text: `Agent process exited with code ${ev.data.code}${detail ? `: ${detail}` : ''}` });
        }
        break;
    }
  }
  return items;
}

function subAgentStep(parent: ToolView | undefined, ev: KelpieEvent): void {
  if (!parent || ev.kind !== 'tool.started') return;
  const { category, title } = (ev as EventOf<'tool.started'>).data;
  parent.steps.push(`${category} ${title}`);
}

/** spawn_agent answers with `{ agentId }` as JSON, or with the reason it refused. */
function settleSpawn(view: SpawnView, ok: boolean, output: string): void {
  try {
    const parsed = JSON.parse(output) as { agentId?: unknown };
    if (ok && typeof parsed.agentId === 'string') {
      view.state = 'done';
      view.agentId = parsed.agentId;
      return;
    }
  } catch {}
  view.state = 'error';
  view.error = output.trim();
}

/** The round-up's own todo list as it last wrote it (not one its sub-agents kept), for the todo dock. */
export function latestTodos(events: readonly KelpieEvent[]): TodoItem[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'todos' && !e.parentCallId) return e.data.items;
  }
  return [];
}
