import { format } from 'date-fns';
import { firstLine } from '@kelpie/protocol';
import type { ToolView } from './chat.js';

/** What a step was, for its icon and tint (the design's activity kinds). */
export type StepKind = 'read' | 'search' | 'edit' | 'run' | 'web' | 'agent' | 'spawn' | 'merge' | 'check' | 'tasks' | 'message' | 'pause' | 'think' | 'tool';

export interface Chip {
  text: string;
  tone?: 'mono' | 'muted' | 'done' | 'fail';
}

/** A tool call as the design shows it: a plain-English title, a few chips, and the raw command behind it. */
export interface Step {
  kind: StepKind;
  title: string;
  chips: Chip[];
  /** The command or argument as the harness ran it, for "Show commands". */
  raw: string;
  /** HH:mm */
  time: string;
}

// Paths outside the repo come through absolute; the home prefix is just noise.
export const tidy = (s: string) => s.replace(/\/(?:Users|home)\/[^/\s]+(?=\/)/g, '~');
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const str = (input: unknown, key: string): string | undefined => {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
};
const quote = (s: string, n = 60) => `“${s.length > n ? `${s.slice(0, n - 1)}…` : s}”`;
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Kelpie's own tools, by name, as the orchestrator uses them. `nameOf` turns an agent id into its title. */
function kelpieStep(tool: ToolView, nameOf: (id: string) => string | undefined): (Pick<Step, 'kind' | 'title'> & { chips?: Chip[] }) | undefined {
  const agent = str(tool.input, 'agentId');
  const who = (agent && nameOf(agent)) ?? 'an agent';
  const items = (tool.input as { items?: unknown } | undefined)?.items;
  const tasks: Chip[] = Array.isArray(items) && items.length ? [{ text: `${items.length} task${items.length === 1 ? '' : 's'}`, tone: 'muted' }] : [];
  switch (tool.name.replace(/^mcp__kelpie__/, '')) {
    case 'list_agents':
      return { kind: 'check', title: 'Checked on the agents' };
    case 'read_agent':
      return { kind: 'check', title: str(tool.input, 'detail') === 'log' ? `Read the log of ${who}` : `Read the report from ${who}` };
    case 'message_agent':
      return { kind: 'message', title: `Messaged ${who}` };
    case 'interrupt_agent':
      return { kind: 'pause', title: `Paused ${who}` };
    case 'spawn_agent':
      return { kind: 'spawn', title: `Started ${str(tool.input, 'title') ?? 'an agent'}` };
    case 'muster_agents':
      return { kind: 'merge', title: 'Mustered the agents’ branches' };
    case 'create_card':
      return { kind: 'tasks', title: `Split the work into a feature: ${quote(str(tool.input, 'title') ?? 'untitled')}`, chips: tasks };
    case 'update_card':
      return { kind: 'tasks', title: 'Updated the feature’s card', chips: tasks };
    case 'workbench_read':
      return { kind: 'read', title: 'Read the Workbench' };
    case 'workbench_post':
      return { kind: 'message', title: str(tool.input, 'to') ? `Left a note for ${str(tool.input, 'to')}` : 'Left a note on the Workbench' };
    default:
      return undefined;
  }
}

/** One tool call in words. Failures carry their first error line; edits their line counts. */
export function stepOf(tool: ToolView, nameOf: (id: string) => string | undefined = () => undefined): Step {
  const path = str(tool.input, 'file_path') ?? str(tool.input, 'notebook_path') ?? str(tool.input, 'path');
  const chips: Chip[] = [];
  let kind: StepKind = 'tool';
  let title: string;
  let raw = tidy(tool.title);

  switch (tool.category) {
    case 'read':
      kind = 'read';
      title = path ? `Read ${base(path)}` : `Read ${tidy(tool.title)}`;
      if (path && base(path) !== tidy(path)) chips.push({ text: tidy(path), tone: 'mono' });
      break;
    case 'edit':
      kind = 'edit';
      title = `${tool.name === 'Write' ? 'Wrote' : 'Edited'} ${path ? base(path) : tidy(tool.title)}`;
      if (tool.delta) chips.push({ text: `+${tool.delta.added} −${tool.delta.removed}`, tone: 'mono' });
      break;
    case 'bash': {
      kind = 'run';
      const command = str(tool.input, 'command');
      title = str(tool.input, 'description') ?? (tool.state === 'running' ? 'Running a command' : 'Ran a command');
      if (command) raw = `$ ${tidy(command)}`;
      break;
    }
    case 'search': {
      kind = 'search';
      const pattern = str(tool.input, 'pattern') ?? str(tool.input, 'query');
      title = tool.name === 'Glob' ? `Looked for files matching ${quote(pattern ?? tool.title)}` : `Searched for ${quote(pattern ?? tool.title)}`;
      break;
    }
    case 'web': {
      kind = 'web';
      const url = str(tool.input, 'url');
      title = url ? `Fetched ${host(url)}` : `Searched the web for ${quote(str(tool.input, 'query') ?? tool.title)}`;
      break;
    }
    case 'task':
      kind = 'agent';
      title = `Ran a sub-agent: ${str(tool.input, 'description') ?? tool.title}`;
      if (tool.steps.length) chips.push({ text: `${tool.steps.length} step${tool.steps.length === 1 ? '' : 's'}`, tone: 'muted' });
      break;
    case 'mcp': {
      const k = tool.name.startsWith('mcp__kelpie__') ? kelpieStep(tool, nameOf) : undefined;
      if (k) {
        ({ kind, title } = k);
        chips.push(...(k.chips ?? []));
      }
      else title = `Used ${tool.name.replace(/^mcp__/, '').replace(/__/g, '/')}`;
      raw = tool.name.replace(/^mcp__/, '').replace(/__/g, '/');
      break;
    }
    default:
      title = tool.title ? `${tool.name}: ${tidy(tool.title)}` : tool.name;
  }

  if (tool.state === 'error') chips.push({ text: tool.output ? `failed: ${firstLine(tool.output, 80)}` : 'failed', tone: 'fail' });
  return { kind, title, chips, raw, time: format(new Date(tool.ts), 'HH:mm') };
}
