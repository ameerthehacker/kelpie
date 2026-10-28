import { ArrowUpIcon, SquareIcon } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Effort, Mode } from '@kelpie/protocol';
import { AttachButton, FileChips, useAttachedFiles } from '@/components/chat/attachments';
import { BranchPicker, DelegationMenu, HarnessMenu, ModeMenu } from '@/components/chat/composer-controls';
import { SuggestionMenu, useSuggestions } from '@/components/chat/composer-suggestions';
import { LimitHint } from '@/components/chat/limit-hint';
import type { Branch } from '@/hooks/use-branches';
import type { ChatStatus } from '@/hooks/use-session';
import type { Delegation } from '@/lib/delegation';
import { nextMode } from '@/lib/modes';
import { cn } from '@/lib/utils';

interface Props {
  status: ChatStatus;
  busy: boolean;
  send: (text: string, files: File[]) => Promise<void>;
  interrupt: () => void;
  /** The round-up's model, or '' for the default. */
  model: string;
  onModel: (model: string) => void;
  /** The round-up's reasoning effort, or '' for the default; and what it reaches, for its menu. */
  effort: '' | Effort;
  onEffort: (effort: '' | Effort) => void;
  effortNote?: string | undefined;
  /** The branch the round-up starts from, or '' while not chosen (Kelpie asks before the first writer). */
  base: string;
  onBase: (branch: string) => void;
  /** The repo's branches; undefined while loading, empty outside a git repo (no picker then). */
  branches: Branch[] | undefined;
  /** Writers have started from the base, so it can no longer change. */
  baseLocked: boolean;
  /** The base can go back to "ask me" (only before the round-up exists). */
  baseClearable: boolean;
  /** The round-up's mode, and the ones its harness has (in Shift+Tab order). */
  mode: Mode;
  modes: readonly Mode[];
  onMode: (mode: Mode) => void;
  /** How much the orchestrator does itself; no pill without `onDelegation` (a sub-agent's page). */
  delegation: Delegation;
  onDelegation?: ((delegation: Delegation) => void) | undefined;
  /** Who the message goes to (a round-up or one of its agents): `/` offers its commands, `@` its files. Undefined before the round-up exists. */
  sessionId?: string | undefined;
  /** The round-up whose agents `@` offers. */
  mentionRoundUpId?: string | undefined;
}

/**
 * The design's composer: the message and its files, the harness, model and effort, the mode, the delegation level, the base
 * branch, and send. Its controls are chips that shrink to icons as it narrows. It clears as
 * soon as a message is sent, and puts the text and files back if sending fails and the box is
 * still empty. While the round-up works, an empty box offers stop; anything typed is still sent
 * (and queued). Files can be attached with the paperclip, dropped on the box, or pasted. `/` at the
 * start offers slash commands, and `@` files and agents to mention (composer-suggestions).
 */
export function Composer({ status, busy, send, interrupt, model, onModel, effort, onEffort, effortNote, base, onBase, branches, baseLocked, baseClearable, mode, modes, onMode, delegation, onDelegation, sessionId, mentionRoundUpId }: Props) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  // Where the caret goes once a picked suggestion is in the text.
  const placeCaret = useRef<number>(undefined);
  useLayoutEffect(() => {
    const at = placeCaret.current;
    if (at === undefined || !box.current) return;
    placeCaret.current = undefined;
    box.current.focus();
    box.current.setSelectionRange(at, at);
  }, [text]);
  const suggest = useSuggestions({
    text,
    caret,
    sessionId,
    roundUpId: mentionRoundUpId,
    onApply: (next, at) => {
      placeCaret.current = at;
      setText(next);
      setCaret(at);
    },
  });
  const listId = useId();
  const attached = useAttachedFiles();
  const { getRootProps, getInputProps, isDragActive, open } = attached.dropzone;
  const ready = !!text.trim() || attached.files.length > 0;
  const submit = () => {
    const message = text.trim();
    const files = attached.files;
    if (!message && !files.length) return;
    setText('');
    attached.setFiles([]);
    send(message, files).catch(() => {
      setText((now) => now || message);
      attached.setFiles((now) => (now.length ? now : files));
    });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // While the suggestions are open, they take the keys they use first.
    if (suggest.onKeyDown(e)) return;
    // As in the terminal: Shift+Tab cycles the mode.
    if (e.key === 'Tab' && e.shiftKey && modes.length > 1) {
      e.preventDefault();
      onMode(nextMode(modes, mode));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const stop = busy && !ready;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="bg-background sticky bottom-0 pt-1 pb-5"
    >
      <div
        {...getRootProps({
          className: cn('border-ln bg-surf shadow-card relative flex flex-col gap-2 rounded-3xl border pt-3.5 pr-3 pb-3 pl-[18px]', isDragActive && 'border-acc ring-acc/30 ring-2'),
        })}
      >
        <input {...getInputProps()} />
        <FileChips files={attached.files} onRemove={attached.remove} className="-ml-1.5" />
        <label htmlFor="composer" className="sr-only">
          Message this round-up
        </label>
        <SuggestionMenu {...suggest.menu} listId={listId}>
          {/* The menu lines up with the box's top edge. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-0" />
        </SuggestionMenu>
        <textarea
          ref={box}
          id="composer"
          rows={2}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKey}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggest.open}
          aria-controls={suggest.open ? listId : undefined}
          onPaste={attached.onPaste}
          placeholder={isDragActive ? 'Drop files to attach them' : 'Ask anything — it gets scheduled, never waited on'}
          className="text-fg field-sizing-content max-h-60 min-h-12 resize-none bg-transparent outline-none"
        />
        {/* A container: as the composer narrows, the chips drop their labels instead of wrapping. */}
        <div className="@container -ml-1.5 flex min-w-0 items-center gap-1.5">
          <AttachButton onClick={open} />
          <HarnessMenu harness="claude-code" model={model} onModel={onModel} effort={effort} onEffort={onEffort} effortNote={effortNote} />
          {modes.length > 1 && <ModeMenu mode={mode} modes={modes} onMode={onMode} />}
          {onDelegation && <DelegationMenu delegation={delegation} onDelegation={onDelegation} />}
          {!!branches?.length && <BranchPicker base={base} onBase={onBase} branches={branches} locked={baseLocked} clearable={baseClearable} />}
          <span className="flex-1" />
          {stop ? (
            <button type="button" onClick={interrupt} aria-label="Stop" className="bg-fg text-background flex size-[38px] shrink-0 items-center justify-center rounded-full">
              <SquareIcon className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              disabled={!ready || status === 'submitted'}
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
