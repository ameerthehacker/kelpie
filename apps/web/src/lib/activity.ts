import type { EventOf, KelpieEvent, ToolCategory } from '@kelpie/protocol';
import type { AgentSummary } from './agents.js';
import { agentsFromText, fromKelpie } from './chat.js';

/** A tool call as the status line needs it: what `tool.started` carries. */
export interface ToolCall {
  name: string;
  category: ToolCategory;
  input: unknown;
}

/** Turns an agent id into its title, when it is known. */
export type NameOf = (id: string) => string | undefined;

const KELPIE = 'mcp__kelpie__';
const THINKING = 'Thinking…';
const WRITING = 'Writing a reply…';

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const str = (input: unknown, key: string): string | undefined => {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
};
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};

/** "A", "A and B", "A, B and 2 more". */
export function nameList(names: readonly string[]): string {
  const unique = [...new Set(names)];
  if (unique.length <= 2) return unique.join(' and ');
  return `${unique.slice(0, 2).join(', ')} and ${unique.length - 2} more`;
}

const agentName = (input: unknown, nameOf: NameOf) => {
  const id = str(input, 'agentId');
  return (id && nameOf(id)) || 'an agent';
};

/**
 * One tool call, in the present tense and plain words, for a live status line: "Reading
 * orchestrator.ts", "Messaging Fix: todo resume". Never the raw call. `nameOf` turns the agent ids
 * in Kelpie's own tools into titles.
 */
export function toolStatus(tool: ToolCall, nameOf: NameOf = () => undefined): string {
  const { input } = tool;
  if (tool.name.startsWith(KELPIE)) {
    switch (tool.name.slice(KELPIE.length)) {
      case 'list_agents':
        return 'Checking agents';
      case 'read_agent': {
        const who = agentName(input, nameOf);
        return str(input, 'detail') === 'log' ? `Reading ${who}'s log` : `Reading ${who}'s report`;
      }
      case 'message_agent':
        return `Messaging ${agentName(input, nameOf)}`;
      case 'interrupt_agent':
        return `Pausing ${agentName(input, nameOf)}`;
      case 'spawn_agent':
        return `Starting ${str(input, 'title') ?? 'an agent'}`;
      case 'muster_agents': {
        const raw = (input as { agentIds?: unknown } | undefined)?.agentIds;
        const ids: unknown[] = Array.isArray(raw) ? raw : [];
        const only = ids.length === 1 && typeof ids[0] === 'string' ? nameOf(ids[0]) : undefined;
        if (only) return `Merging ${only}'s branch`;
        return ids.length > 1 ? `Merging ${ids.length} branches` : 'Merging branches';
      }
      case 'list_branches':
        return 'Checking branches';
      case 'set_base_branch':
        return 'Setting the base branch';
      default:
        return 'Working with agents';
    }
  }
  const path = str(input, 'file_path') ?? str(input, 'notebook_path');
  switch (tool.category) {
    case 'read':
      return path ? `Reading ${base(path)}` : 'Reading files';
    case 'search':
      return tool.name === 'Glob' ? 'Looking for files' : 'Searching the repo';
    case 'edit':
      return path ? `Editing ${base(path)}` : 'Editing files';
    case 'bash':
      return 'Running a command';
    case 'web': {
      const url = str(input, 'url');
      const h = url && host(url);
      return h ? `Reading ${h}` : 'Searching the web';
    }
    case 'task':
      return 'Running a sub-agent';
    case 'todo':
      return 'Updating the plan';
    case 'mcp': {
      const server = tool.name.split('__')[1];
      return server ? `Using ${server}` : 'Using a tool';
    }
  }
  if (tool.name === 'ExitPlanMode') return 'Writing up a plan';
  return 'Working…';
}

/** Several calls running at once (the model fans out): one line for all of them where they agree. */
function toolsStatus(tools: readonly ToolCall[], nameOf: NameOf): string {
  const last = tools.at(-1)!;
  if (tools.length > 1 && tools.every((t) => t.name === last.name)) {
    const names = (key: string) => tools.map((t) => str(t.input, key)).filter((s): s is string => !!s);
    switch (last.name) {
      case `${KELPIE}read_agent`:
        return `Reading reports from ${nameList(tools.map((t) => agentName(t.input, nameOf)))}`;
      case `${KELPIE}message_agent`:
        return `Messaging ${nameList(tools.map((t) => agentName(t.input, nameOf)))}`;
      case `${KELPIE}spawn_agent`:
        return tools.length > 2 ? `Starting ${tools.length} agents` : `Starting ${nameList(names('title'))}`;
      case 'Read':
        return `Reading ${tools.length} files`;
    }
  }
  return toolStatus(last, nameOf);
}

/** What an open request waits on the person for: a plan to review, a question to answer, or an approval. */
function waitingFor(data: EventOf<'permission.requested'>['data']): string {
  if (data.tool === 'ExitPlanMode') return 'Waiting for you to review the plan';
  return data.questions?.length ? 'Waiting for your answer' : 'Waiting for your approval';
}

/** The agents a notification Kelpie sent covers, by their current titles. */
function reported(data: EventOf<'message'>['data'], nameOf: NameOf): string[] {
  const updates = data.agents ?? agentsFromText(data.text);
  return updates.map((a) => nameOf(a.agentId) ?? a.title);
}

/**
 * What a busy round-up is doing right now, as one short line: "Reading reports from Fix: notifications
 * and Review: docs", "Thinking…", "Merging 2 branches". Looks only at the turn in progress (since the
 * last turn ended), at the round-up's own events (not what its sub-agents' tools do). Pure.
 *
 * The harness sends whole blocks, not tokens: a thinking block arrives when the thinking is done, a
 * text block when it is written. So "Thinking…" covers everything the model is working out between
 * steps, and "Writing a reply…" follows text it has started to write.
 */
export function orchestratorStatus(events: readonly KelpieEvent[], agents: readonly Pick<AgentSummary, 'id' | 'title'>[] = []): string {
  const titles = new Map(agents.map((a) => [a.id, a.title]));
  const nameOf: NameOf = (id) => titles.get(id);
  const finished = new Set<string>();
  const resolved = new Set<string>();
  const running: ToolCall[] = [];
  const done: ToolCall[] = [];

  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.parentCallId) continue;
    switch (e.kind) {
      case 'turn.ended':
      case 'process.exited':
        return settle();
      case 'activity':
        if (!e.data.busy) return settle();
        break;
      case 'tool.finished':
        finished.add(e.data.callId);
        break;
      case 'tool.started':
        if (finished.has(e.data.callId)) done.unshift(e.data);
        else running.unshift(e.data);
        break;
      case 'permission.resolved':
        resolved.add(e.data.requestId);
        break;
      case 'permission.requested':
        if (!resolved.has(e.data.requestId)) return waitingFor(e.data);
        break;
      // The model's own steps: whatever tools came after them are the latest thing it did.
      case 'thinking':
        return settle(THINKING);
      case 'message':
        if (e.data.role === 'assistant') return settle(WRITING);
        if (fromKelpie(e.data)) {
          const names = reported(e.data, nameOf);
          return settle(names.length === 1 ? `Reading the report from ${names[0]}` : names.length ? `Reading reports from ${nameList(names)}` : THINKING);
        }
        return settle(THINKING);
    }
  }
  return settle();

  /** Tools still running win; once all have answered, the model is working out what comes next. */
  function settle(before = THINKING): string {
    if (running.length) return toolsStatus(running, nameOf);
    if (!done.length) return before;
    // Agents' reports in hand: it is reading them over before it decides.
    if (done.every((t) => t.name === `${KELPIE}read_agent`)) {
      const names = done.map((t) => agentName(t.input, nameOf));
      return `Going over ${names.length === 1 ? `${names[0]}'s report` : `reports from ${nameList(names)}`}`;
    }
    return THINKING;
  }
}
