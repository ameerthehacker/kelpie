import { ChevronRightIcon, FilePenLineIcon, GlobeIcon, ShieldQuestionIcon, TerminalIcon } from 'lucide-react';
import { useState, type ComponentType, type FormEvent } from 'react';
import { broaderRule, type ApprovalGroup } from '@/lib/approvals';
import { cn } from '@/lib/utils';

const TOOL_ICON: Record<string, ComponentType<{ className?: string; strokeWidth?: number }>> = {
  Bash: TerminalIcon,
  WebFetch: GlobeIcon,
  WebSearch: GlobeIcon,
  Edit: FilePenLineIcon,
  Write: FilePenLineIcon,
  NotebookEdit: FilePenLineIcon,
};

export type GroupAnswer = { decision: 'allow'; remember?: boolean } | { decision: 'deny'; message?: string };

/** What a request asks, in full: the command for Bash, else its input as JSON. */
function detail(input: unknown): string {
  const i = input as { command?: unknown } | undefined;
  if (typeof i?.command === 'string') return i.command;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

const btn = 'h-7 shrink-0 rounded-full px-3 text-xs font-medium disabled:opacity-50';

/**
 * One thing asked for, by one or many agents: allow it (once each), allow it for the whole round-up,
 * or deny it with an optional note. Opening it shows each agent's exact request.
 */
export function ApprovalRow({ group, selected, busy, onAnswer, onSelect, canRemember = true }: {
  group: ApprovalGroup;
  selected: boolean;
  busy: boolean;
  onAnswer: (answer: GroupAnswer) => void;
  onSelect: () => void;
  /** "Allow for round-up" needs a rule to save (and an agent asking, not the orchestrator). */
  canRemember?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const Icon = TOOL_ICON[group.tool] ?? ShieldQuestionIcon;
  const n = group.items.length;
  const broader = broaderRule(group);
  const agents = group.agents.length > 3 ? `${group.agents.slice(0, 3).join(', ')} +${group.agents.length - 3}` : group.agents.join(', ');
  const deny = (e: FormEvent) => {
    e.preventDefault();
    onAnswer({ decision: 'deny', ...(note.trim() ? { message: note.trim() } : {}) });
  };

  return (
    <li
      aria-selected={selected}
      onClick={onSelect}
      className={cn('hover:bg-raise/50 flex flex-col gap-1.5 rounded-xl px-2.5 py-2', selected && 'group-focus-within/approvals:bg-raise/70')}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? 'Hide the requests' : 'Show the requests'}
          className="text-mu2 hover:text-fg -ml-1 rounded p-0.5"
        >
          <ChevronRightIcon className={cn('size-3.5 transition-transform', open && 'rotate-90')} strokeWidth={2.2} />
        </button>
        <Icon className="text-mu2 size-4 shrink-0" strokeWidth={1.9} />
        <span className="flex min-w-0 flex-1 flex-col">
          <code className="text-fg truncate font-mono text-[13px]" title={group.label}>
            {group.label}
          </code>
          <span className="text-mu truncate text-xs">
            {group.tool} · {agents}
            {n > 1 && ` · ${n} requests`}
          </span>
          {canRemember && broader && <span className="text-mu2 truncate text-[11px]">For the round-up: allows {broader}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <button type="button" disabled={busy} onClick={() => onAnswer({ decision: 'allow' })} className={cn(btn, 'bg-acc text-accfg')}>
            Allow{n > 1 ? ` ${n}` : ''}
          </button>
          {canRemember && group.rule && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAnswer({ decision: 'allow', remember: true })}
              title={`Allow ${group.rule} for every agent in this round-up, now and later`}
              className={cn(btn, 'bg-chip text-fg2 hover:bg-raise')}
            >
              Allow for round-up
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => setNoting((v) => !v)} className={cn(btn, 'bg-chip text-fail hover:bg-raise')}>
            Deny…
          </button>
        </span>
      </div>
      {noting && (
        <form onSubmit={deny} className="flex items-center gap-1.5 pl-7">
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              // Closes the note only: the page's own Escape (back from an agent's page) must not fire too.
              if (e.key !== 'Escape') return;
              e.preventDefault();
              setNoting(false);
            }}
            placeholder="Tell the agent why, or what to do instead (optional)"
            className="bg-chip text-fg h-8 min-w-0 flex-1 rounded-full px-3 text-[13px] outline-none"
          />
          <button type="submit" disabled={busy} className={cn(btn, 'bg-fail text-white')}>
            Deny{n > 1 ? ` ${n}` : ''}
          </button>
        </form>
      )}
      {open && (
        <ul className="flex flex-col gap-1.5 pl-7">
          {group.items.map((a) => (
            <li key={`${a.sessionId}:${a.requestId}`} className="flex flex-col gap-0.5">
              <span className="text-mu2 text-[11px]">{a.agentTitle}</span>
              <pre className="bg-chip text-fg2 max-h-40 overflow-auto rounded-lg px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap">{detail(a.input)}</pre>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
