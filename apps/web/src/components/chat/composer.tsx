import { ArrowUpIcon, ChevronDownIcon, GitBranchIcon, SquareIcon } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { HarnessMark } from '@/components/harness-mark';
import { LimitHint } from '@/components/chat/limit-hint';
import type { Branch } from '@/hooks/use-branches';
import type { ChatStatus } from '@/hooks/use-session';
import { modelLabel } from '@/lib/harnesses';
import { cn } from '@/lib/utils';

/** The Claude Code CLI's model aliases; '' leaves the choice to the harness. */
const MODELS = ['', 'opus', 'sonnet', 'haiku'];

interface Props {
  status: ChatStatus;
  busy: boolean;
  send: (text: string) => Promise<void>;
  interrupt: () => void;
  /** The round-up's model, or '' for the default. */
  model: string;
  onModel: (model: string) => void;
  /** The branch the round-up starts from, or '' while not chosen (Kelpie asks before the first writer). */
  base: string;
  onBase: (branch: string) => void;
  /** The repo's branches; undefined while loading, empty outside a git repo (no picker then). */
  branches: Branch[] | undefined;
  /** Writers have started from the base, so it can no longer change. */
  baseLocked: boolean;
}

const chip = 'bg-chip relative flex h-8 items-center rounded-full pr-2 pl-3';
const select = 'text-fg2 cursor-pointer appearance-none bg-transparent pr-4 text-[13px] outline-none disabled:cursor-default [&>*]:bg-[var(--surf)] [&>optgroup>option]:bg-[var(--surf)]';

/** Where the round-up's feature branch starts: remote branches first, then local ones. */
function BasePicker({ base, onBase, branches, locked }: { base: string; onBase: (b: string) => void; branches: Branch[]; locked: boolean }) {
  const remote = branches.filter((b) => b.remote);
  const local = branches.filter((b) => !b.remote);
  // A base chosen earlier stays listed even if the branch has since gone.
  const known = !base || branches.some((b) => b.name === base);
  return (
    <label title={locked ? `Writers started from ${base}; the base is fixed now` : 'The branch this round-up starts from'} className={cn(chip, !locked && 'hover:bg-raise')}>
      <span className="sr-only">Base branch</span>
      <GitBranchIcon aria-hidden="true" className="text-mu2 mr-1.5 size-3.5" strokeWidth={2} />
      <select value={base} disabled={locked} onChange={(e) => onBase(e.target.value)} className={cn(select, 'max-w-48 truncate')}>
        <option value="">Base: ask me</option>
        {!known && <option value={base}>{base}</option>}
        {remote.length > 0 && (
          <optgroup label="Remote">
            {remote.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </optgroup>
        )}
        {local.length > 0 && (
          <optgroup label="Local">
            {local.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {!locked && <ChevronDownIcon aria-hidden="true" className="text-mu2 pointer-events-none absolute right-2.5 size-[11px]" strokeWidth={2.4} />}
    </label>
  );
}

/**
 * The design's composer: the message, the harness and model, and send. It clears as soon as a
 * message is sent, and puts the text back if sending fails and the box is still empty. While
 * the round-up works, an empty box offers stop; anything typed is still sent (and queued).
 */
export function Composer({ status, busy, send, interrupt, model, onModel, base, onBase, branches, baseLocked }: Props) {
  const [text, setText] = useState('');
  const submit = () => {
    const message = text.trim();
    if (!message) return;
    setText('');
    send(message).catch(() => setText((now) => now || message));
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const stop = busy && !text.trim();
  const models = model && !MODELS.includes(model) ? [...MODELS, model] : MODELS;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="bg-background sticky bottom-0 pt-1 pb-5"
    >
      <div className="border-ln bg-surf shadow-card flex flex-col gap-2 rounded-3xl border pt-3.5 pr-3 pb-3 pl-[18px]">
        <label htmlFor="composer" className="sr-only">
          Message this round-up
        </label>
        <textarea
          id="composer"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder="Ask anything — it gets scheduled, never waited on"
          className="text-fg field-sizing-content max-h-60 min-h-12 resize-none bg-transparent outline-none"
        />
        <div className="-ml-1.5 flex flex-wrap items-center gap-1.5">
          <span className="bg-chip text-fg2 flex h-8 items-center gap-[7px] rounded-full pr-3 pl-[7px] text-[13px]">
            <HarnessMark harness="claude-code" />
            Claude Code
          </span>
          <label className={cn(chip, 'hover:bg-raise')}>
            <span className="sr-only">Model</span>
            <select value={model} onChange={(e) => onModel(e.target.value)} className={select}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m ? modelLabel(m) : 'Default model'}
                </option>
              ))}
            </select>
            <ChevronDownIcon aria-hidden="true" className="text-mu2 pointer-events-none absolute right-2.5 size-[11px]" strokeWidth={2.4} />
          </label>
          {!!branches?.length && <BasePicker base={base} onBase={onBase} branches={branches} locked={baseLocked} />}
          <span className="flex-1" />
          {stop ? (
            <button type="button" onClick={interrupt} aria-label="Stop" className="bg-fg text-background flex size-[38px] shrink-0 items-center justify-center rounded-full">
              <SquareIcon className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              disabled={!text.trim() || status === 'submitted'}
              className="bg-acc text-accfg flex size-[38px] shrink-0 items-center justify-center rounded-full disabled:opacity-50"
            >
              <ArrowUpIcon className="size-4" strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
      {/* Every round-up runs on Claude Code for now. */}
      <LimitHint harness="claude-code" />
    </form>
  );
}
