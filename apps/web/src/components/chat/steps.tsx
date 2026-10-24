import {
  BotIcon,
  EllipsisIcon,
  EyeIcon,
  GitForkIcon,
  GlobeIcon,
  ListChecksIcon,
  type LucideIcon,
  MessageSquareIcon,
  PauseIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-react';
import { Fragment, useEffect, useState, type CSSProperties } from 'react';
import type { BundledLanguage } from 'shiki';
import { highlightCode } from '@/components/ai-elements/code-block';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useShowCommands } from '@/hooks/use-show-commands';
import type { ToolView } from '@/lib/chat';
import { stepOf, tidy, type Chip, type StepKind } from '@/lib/steps';
import { cn } from '@/lib/utils';

const ICON: Record<StepKind, LucideIcon> = {
  read: EyeIcon,
  search: SearchIcon,
  edit: PencilIcon,
  run: TerminalIcon,
  web: GlobeIcon,
  agent: BotIcon,
  spawn: GitForkIcon,
  check: ListChecksIcon,
  message: MessageSquareIcon,
  pause: PauseIcon,
  think: EllipsisIcon,
  tool: WrenchIcon,
};

// The design's tint per kind of activity.
const TINT: Record<StepKind, string> = {
  read: 'text-mu',
  search: 'text-mu',
  edit: 'text-run',
  run: 'text-vio',
  web: 'text-mu',
  agent: 'text-acc',
  spawn: 'text-acc',
  check: 'text-acc',
  message: 'text-acc',
  pause: 'text-wait',
  think: 'text-mu2',
  tool: 'text-mu',
};

const CHIP: Record<NonNullable<Chip['tone']>, string> = {
  mono: 'font-mono text-fg2',
  muted: 'text-mu',
  done: 'text-done',
  fail: 'text-fail',
};

function inputText(input: unknown): string | undefined {
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
  '+': 'bg-done/10 text-done',
  '-': 'bg-fail/10 text-fail',
  ' ': 'text-mu',
};

function Diff({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="space-y-1">
      <div className="text-mu2 text-xs">Changes</div>
      <pre className="bg-well max-h-72 overflow-auto rounded-[10px] py-2 font-mono text-xs leading-relaxed">
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

function Block({ label, text, tone, language }: { label: string; text: string; tone?: 'error'; language?: BundledLanguage }) {
  return (
    <div className="space-y-1">
      <div className="text-mu2 text-xs">{label}</div>
      <pre
        className={cn(
          'max-h-72 overflow-auto rounded-[10px] px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all',
          tone === 'error' ? 'bg-fail/10 text-fail' : 'bg-well text-fg2',
        )}
      >
        {language ? <Highlighted code={text} language={language} /> : text}
      </pre>
    </div>
  );
}

/** A step's icon on its round chip, as in the design. */
export function StepIcon({ kind, tone }: { kind: StepKind; tone?: 'running' | 'error' }) {
  const Icon = ICON[kind];
  return (
    <span aria-hidden="true" className={cn('bg-chip flex size-[26px] items-center justify-center rounded-full', tone === 'error' ? 'text-fail' : TINT[kind], tone === 'running' && 'animate-k-pulse')}>
      <Icon className="size-[13px]" strokeWidth={2.2} />
    </span>
  );
}

/** A step's meta line: its time, then its chips. */
export function StepMeta({ time, chips }: { time: string; chips: Chip[] }) {
  return (
    <div className="text-mu2 flex flex-wrap items-center gap-1.5 text-xs">
      <span>{time}</span>
      {chips.map((c, i) => (
        <span key={i} className={cn('bg-chip inline-flex h-5 max-w-full items-center truncate rounded-full px-2 text-[11px]', CHIP[c.tone ?? 'mono'])}>
          {c.text}
        </span>
      ))}
    </div>
  );
}

/** The raw command behind a step, when "Show commands" is on. */
export function RawCommand({ text }: { text: string }) {
  // A shell command, highlighted as one; its "$ " prompt stays quiet. Anything else is shown as is.
  const command = text.startsWith('$ ') ? text.slice(2) : undefined;
  return (
    <div className="bg-well text-fg2 overflow-x-auto rounded-[10px] px-2.5 py-2 font-mono text-xs whitespace-pre">
      {command === undefined ? (
        text
      ) : (
        <>
          <span className="text-mu2 select-none">$ </span>
          <Highlighted code={command} language="bash" />
        </>
      )}
    </div>
  );
}

/**
 * Code coloured by Shiki, in the theme's light or dark colours, on whatever background holds it.
 * Plain until the highlighter has loaded the language.
 */
function Highlighted({ code, language }: { code: string; language: BundledLanguage }) {
  const [tokens, setTokens] = useState(() => highlightCode(code, language));
  useEffect(() => {
    let live = true;
    setTokens(highlightCode(code, language, (t) => live && setTokens(t)));
    return () => {
      live = false;
    };
  }, [code, language]);
  if (!tokens) return code;
  return tokens.tokens.map((line, i) => (
    <Fragment key={i}>
      {i > 0 && '\n'}
      {line.map((t, j) => (
        <span key={j} style={t.htmlStyle as CSSProperties} className="dark:!text-[var(--shiki-dark)]">
          {t.content}
        </span>
      ))}
    </Fragment>
  ));
}

/** One tool call: its title, time and chips; opening it shows the diff, input or output. */
export function StepRow({ tool, nameOf }: { tool: ToolView; nameOf?: (id: string) => string | undefined }) {
  const [showRaw] = useShowCommands();
  const step = stepOf(tool, nameOf);
  const diff = tool.category === 'edit' ? editDiff(tool.input) : undefined;
  const input = diff || tool.category === 'bash' ? undefined : inputText(tool.input);
  // A successful edit's output is boilerplate ("The file … has been updated"); the diff says it all.
  const output = diff && tool.state === 'done' ? undefined : tool.output;
  const details = !!(diff || input || output || tool.steps.length);
  return (
    <Collapsible className="group/step grid grid-cols-[26px_1fr] gap-3">
      <StepIcon kind={step.kind} tone={tool.state === 'running' ? 'running' : tool.state === 'error' ? 'error' : undefined} />
      <div className="flex min-w-0 flex-col gap-[5px] pt-0.5">
        <CollapsibleTrigger disabled={!details} className="hover:text-strong text-left text-sm leading-[1.45] disabled:cursor-default disabled:hover:text-inherit">
          {step.title}
        </CollapsibleTrigger>
        <StepMeta time={step.time} chips={step.chips} />
        {showRaw && <RawCommand text={step.raw} />}
        <CollapsibleContent className="flex flex-col gap-3 pt-1">
          {diff && <Diff lines={diff} />}
          {input && <Block label="Input" text={input} language="json" />}
          {tool.steps.length > 0 && <Block label="Sub-agent steps" text={tool.steps.map(tidy).join('\n')} />}
          {output && <Block label={tool.state === 'error' ? 'Error' : 'Output'} text={output} tone={tool.state === 'error' ? 'error' : undefined} />}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/** The "Show commands" switch. */
export function ShowCommandsToggle() {
  const [on, toggle] = useShowCommands();
  return (
    <button type="button" onClick={toggle} aria-pressed={on} className="bg-chip text-mu hover:text-fg h-[26px] shrink-0 rounded-full px-2.5 text-xs">
      {on ? 'Hide commands' : 'Show commands'}
    </button>
  );
}

/** A run of tool calls, headed "Kelpie · N steps" as in the design. */
export function StepGroup({ tools, actor, nameOf }: { tools: ToolView[]; actor: string; nameOf?: (id: string) => string | undefined }) {
  return (
    <div className="not-prose flex flex-col gap-3.5">
      <div className="text-mu2 flex items-center gap-2 text-xs">
        <span>
          {actor} · {tools.length} step{tools.length === 1 ? '' : 's'}
        </span>
        <span className="bg-ln h-px flex-1" />
        <ShowCommandsToggle />
      </div>
      {tools.map((t) => (
        <StepRow key={t.callId} tool={t} nameOf={nameOf} />
      ))}
    </div>
  );
}
