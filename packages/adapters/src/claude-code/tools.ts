import { isAbsolute, relative } from 'node:path';
import type { TodoItem, TodoStatus, ToolCategory } from '@kelpie/protocol';

type Obj = Record<string, any>;

const CATEGORY: Record<string, ToolCategory> = {
  Read: 'read',
  Glob: 'search',
  Grep: 'search',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'bash',
  WebFetch: 'web',
  WebSearch: 'web',
  TodoWrite: 'todo',
  TaskCreate: 'todo',
  TaskUpdate: 'todo',
  TaskList: 'todo',
  TaskGet: 'todo',
  // The sub-agent tool is called `Agent` in current CLIs and `Task` in older ones.
  Agent: 'task',
  Task: 'task',
};

export function toolCategory(name: string): ToolCategory {
  if (name.startsWith('mcp__')) return 'mcp';
  return CATEGORY[name] ?? 'other';
}

function oneLine(s: string, max = 120): string {
  const line = s.split('\n', 1)[0]!.trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

export function displayPath(p: string, cwd: string | undefined): string {
  if (!cwd || !isAbsolute(p)) return p;
  const rel = relative(cwd, p);
  if (rel === '') return '.';
  return rel.startsWith('..') ? p : rel;
}

/** One-line summary for the live log: a path, a command, a query. */
export function toolTitle(name: string, input: Obj, cwd: string | undefined): string {
  const path = input.file_path ?? input.notebook_path ?? input.path;
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return typeof path === 'string' ? displayPath(path, cwd) : name;
    case 'Glob':
    case 'Grep': {
      const dir = typeof input.path === 'string' ? displayPath(input.path, cwd) : '.';
      const where = dir === '.' ? '' : ` in ${dir}`;
      return oneLine(`${input.pattern ?? ''}${where}`);
    }
    case 'Bash':
      return oneLine(String(input.command ?? input.description ?? 'Bash'));
    case 'WebFetch':
      return oneLine(String(input.url ?? 'WebFetch'));
    case 'WebSearch':
      return oneLine(String(input.query ?? 'WebSearch'));
    case 'Agent':
    case 'Task':
      return oneLine(String(input.description ?? input.subagent_type ?? name));
    case 'TaskCreate':
      return oneLine(String(input.subject ?? 'TaskCreate'));
    case 'TaskUpdate':
      return `#${input.taskId}${input.status ? ` → ${input.status}` : ''}`;
  }
  if (name.startsWith('mcp__')) return name.slice('mcp__'.length).split('__').join('/');
  return name;
}

/** Flattens a tool_result `content` (string or block list) into text. */
export function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content
    .map((b: Obj) => {
      if (b?.type === 'text') return String(b.text ?? '');
      if (b?.type === 'tool_reference') return `[tool: ${b.tool_name}]`;
      if (b?.type === 'image') return '[image]';
      return JSON.stringify(b);
    })
    .join('\n');
}

export interface LineDelta {
  path: string;
  op: 'edit' | 'write';
  added: number;
  removed: number;
}

const countLines = (s: unknown) => (typeof s === 'string' && s.length ? s.replace(/\n$/, '').split('\n').length : 0);

/**
 * Line counts for a successful edit-category tool. Prefers the CLI's own
 * structuredPatch; falls back to diffing the tool input.
 */
export function fileDelta(name: string, input: Obj, result: Obj | undefined): LineDelta | undefined {
  if (!['Edit', 'MultiEdit', 'Write'].includes(name)) return undefined;
  const path = result?.filePath ?? input.file_path;
  if (typeof path !== 'string') return undefined;
  const op = name === 'Write' ? 'write' : 'edit';

  const patch = result?.structuredPatch;
  if (Array.isArray(patch) && patch.length) {
    let added = 0;
    let removed = 0;
    for (const hunk of patch) {
      for (const l of hunk.lines ?? []) {
        if (l.startsWith('+')) added++;
        else if (l.startsWith('-')) removed++;
      }
    }
    return { path, op, added, removed };
  }
  if (name === 'Write') return { path, op, added: countLines(input.content), removed: 0 };
  const edits: Obj[] = name === 'MultiEdit' ? (input.edits ?? []) : [input];
  return {
    path,
    op,
    added: edits.reduce((n, e) => n + countLines(e.new_string), 0),
    removed: edits.reduce((n, e) => n + countLines(e.old_string), 0),
  };
}

const TODO_STATUS: Record<string, TodoStatus> = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
};

/**
 * Applies a todo-tool call to the current list. Returns the new list, or
 * undefined when the call did not change it (reads, failures).
 */
export function applyTodoTool(name: string, input: Obj, result: Obj | undefined, items: TodoItem[]): TodoItem[] | undefined {
  switch (name) {
    // Legacy single-shot tool: input is the whole list.
    case 'TodoWrite':
      return (input.todos ?? []).map((t: Obj, i: number) => ({
        id: String(t.id ?? i + 1),
        text: String(t.content ?? ''),
        status: TODO_STATUS[t.status] ?? 'pending',
        ...(t.activeForm ? { activeText: String(t.activeForm) } : {}),
      }));
    case 'TaskCreate': {
      const id = result?.task?.id;
      if (id == null) return undefined;
      const item: TodoItem = {
        id: String(id),
        text: String(input.subject ?? result?.task?.subject ?? ''),
        status: 'pending',
        ...(input.activeForm ? { activeText: String(input.activeForm) } : {}),
      };
      // An id already listed is stale (e.g. kept from a session the CLI has since lost): ids are unique.
      return items.some((t) => t.id === item.id) ? items.map((t) => (t.id === item.id ? item : t)) : [...items, item];
    }
    case 'TaskUpdate': {
      if (result && result.success === false) return undefined;
      const id = String(input.taskId);
      // Unknown id, e.g. a task created before this process resumed the session.
      if (!items.some((t) => t.id === id)) return undefined;
      if (input.status === 'deleted') return items.filter((t) => t.id !== id);
      return items.map((t) =>
        t.id !== id
          ? t
          : {
              ...t,
              ...(input.subject ? { text: String(input.subject) } : {}),
              ...(TODO_STATUS[input.status] ? { status: TODO_STATUS[input.status]! } : {}),
              ...(input.activeForm ? { activeText: String(input.activeForm) } : {}),
            },
      );
    }
  }
  return undefined;
}
