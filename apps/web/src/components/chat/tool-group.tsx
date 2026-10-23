import {
  BotIcon,
  ChevronRightIcon,
  FilePenIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  type LucideIcon,
  PlugIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
  XCircleIcon,
} from 'lucide-react';
import type { ToolCategory } from '@kelpie/protocol';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Spinner } from '@/components/ui/spinner';
import type { ToolView } from '@/lib/chat';
import { cn } from '@/lib/utils';

const ICONS: Record<ToolCategory, LucideIcon> = {
  read: FileTextIcon,
  search: SearchIcon,
  edit: FilePenIcon,
  bash: SquareTerminalIcon,
  web: GlobeIcon,
  todo: ListTodoIcon,
  task: BotIcon,
  mcp: PlugIcon,
  other: WrenchIcon,
};

// Paths outside the repo come through absolute; the home prefix is just noise.
const tidy = (s: string) => s.replace(/\/(?:Users|home)\/[^/\s]+(?=\/)/g, '~');

function inputText(input: unknown): string | undefined {
  if (input && typeof input === 'object' && 'command' in input && typeof input.command === 'string') return `$ ${input.command}`;
  if (input === undefined || (typeof input === 'object' && input && !Object.keys(input).length)) return undefined;
  return JSON.stringify(input, null, 2);
}

type DiffLine = { op: ' ' | '+' | '-'; text: string };

const lines = (s: string) => s.replace(/\n$/, '').split('\n');

/** old → new as changed lines with a little context; good enough for the small hunks Edit makes. */
function hunk(oldText: string, newText: string, context = 2): DiffLine[] {
  const a = lines(oldText);
  const b = lines(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return [
    ...a.slice(Math.max(0, pre - context), pre).map((text) => ({ op: ' ' as const, text })),
    ...a.slice(pre, a.length - suf).map((text) => ({ op: '-' as const, text })),
    ...b.slice(pre, b.length - suf).map((text) => ({ op: '+' as const, text })),
    ...a.slice(a.length - suf, a.length - suf + context).map((text) => ({ op: ' ' as const, text })),
  ];
}

/** A diff for file-editing tools, from their input. */
function editDiff(input: unknown): DiffLine[] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as { old_string?: unknown; new_string?: unknown; content?: unknown; edits?: unknown };
  if (typeof i.old_string === 'string' && typeof i.new_string === 'string') return hunk(i.old_string, i.new_string);
  if (typeof i.content === 'string') return lines(i.content).map((text) => ({ op: '+', text }));
  if (Array.isArray(i.edits)) {
    return i.edits.flatMap((e: { old_string?: unknown; new_string?: unknown }, n) => [
      ...(n ? [{ op: ' ' as const, text: '…' }] : []),
      ...hunk(String(e.old_string ?? ''), String(e.new_string ?? '')),
    ]);
  }
  return undefined;
}

const DIFF_STYLE = {
  '+': 'bg-green-500/10 text-green-700 dark:text-green-400',
  '-': 'bg-red-500/10 text-red-700 dark:text-red-400',
  ' ': 'text-muted-foreground',
};

function Diff({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">Changes</div>
      <pre className="bg-muted/60 max-h-72 overflow-auto rounded-md py-2 font-mono text-xs leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className={cn('px-3 whitespace-pre-wrap break-all', DIFF_STYLE[l.op])}>
            <span className="mr-2 select-none opacity-60">{l.op}</span>
            {l.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

function Block({ label, text, tone }: { label: string; text: string; tone?: 'error' }) {
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">{label}</div>
      <pre
        className={cn(
          'max-h-72 overflow-auto rounded-md px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all',
          tone === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-muted/60',
        )}
      >
        {text}
      </pre>
    </div>
  );
}

function ToolRow({ tool }: { tool: ToolView }) {
  const Icon = ICONS[tool.category];
  const diff = tool.category === 'edit' ? editDiff(tool.input) : undefined;
  const input = diff ? undefined : inputText(tool.input);
  // A successful edit's output is boilerplate ("The file … has been updated"); the diff says it all.
  const output = diff && tool.state === 'done' ? undefined : tool.output;
  return (
    <Collapsible className="group/tool">
      <CollapsibleTrigger className="hover:bg-muted/50 flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors">
        <Icon className={cn('size-4 shrink-0', tool.state === 'error' ? 'text-destructive' : 'text-muted-foreground')} />
        <span className="text-muted-foreground shrink-0 font-medium">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{tidy(tool.title)}</span>
        {tool.delta && (
          <span className="shrink-0 font-mono text-xs tabular-nums">
            <span className="text-green-600 dark:text-green-500">+{tool.delta.added}</span>{' '}
            <span className="text-red-600 dark:text-red-500">−{tool.delta.removed}</span>
          </span>
        )}
        {tool.state === 'running' && <Spinner className="text-muted-foreground size-3.5 shrink-0" />}
        {tool.state === 'error' && <XCircleIcon aria-label="Failed" className="text-destructive size-3.5 shrink-0" />}
        <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0 opacity-0 transition group-hover/tool:opacity-100 group-data-[state=open]/tool:rotate-90 group-data-[state=open]/tool:opacity-100" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 px-3 pt-1 pb-3">
        {diff && <Diff lines={diff} />}
        {input && <Block label="Input" text={input} />}
        {tool.steps.length > 0 && <Block label="Sub-agent steps" text={tool.steps.map(tidy).join('\n')} />}
        {output && <Block label={tool.state === 'error' ? 'Error' : 'Output'} text={output} tone={tool.state === 'error' ? 'error' : undefined} />}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A run of consecutive tool calls, as one compact log. */
export function ToolGroup({ tools }: { tools: ToolView[] }) {
  return (
    <div className="not-prose my-1 divide-y overflow-hidden rounded-lg border">
      {tools.map((t) => (
        <ToolRow key={t.callId} tool={t} />
      ))}
    </div>
  );
}
