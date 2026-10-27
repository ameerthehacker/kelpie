import { useEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { renameTo, titleOf, type RoundUp } from '../../lib/round-ups.js';
import { cn } from '../../lib/utils.js';

/**
 * Text that fades in when it changes in place (a round-up named by Claude), keeping its box: no
 * fade on first render, none with reduced motion. Key it by what it names, so showing another
 * round-up's title is a first render, not a change.
 */
export function FadeText({ text, className }: { text: string; className?: string }) {
  const first = useRef(text);
  return (
    <span key={text} className={cn(text !== first.current && 'animate-in fade-in-0 duration-700 motion-reduce:animate-none', className)}>
      {text}
    </span>
  );
}

/**
 * Renaming a round-up in a text field: `start` opens it, Enter saves, Escape cancels, leaving it saves.
 * What is saved is only what the person typed: a title that changes while the field is open (Claude
 * naming the round-up) is not taken for theirs, and the field closing twice (Enter, then the blur of
 * its removal) saves once.
 */
export function useTitleEdit(roundUp: Pick<RoundUp, 'id' | 'title' | 'titleSource'>, onRename: (id: string, title: string) => unknown) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  /** The field's text when it opened; undefined once it is closed. */
  const started = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!editing) return;
    started.current = input.current?.value ?? '';
    input.current?.focus();
    input.current?.select();
  }, [editing]);

  const finish = (save: boolean) => {
    const from = started.current;
    const typed = input.current?.value;
    started.current = undefined;
    setEditing(false);
    if (!save || from === undefined || typed === undefined || typed === from) return;
    const next = renameTo(roundUp, typed);
    if (next !== undefined) void onRename(roundUp.id, next);
  };

  const field = {
    ref: input,
    'aria-label': 'Round-up title',
    defaultValue: roundUp.title,
    placeholder: roundUp.titleSource === 'person' ? 'Clear to let Claude name it' : titleOf(roundUp),
    maxLength: 200,
    onBlur: () => finish(true),
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    },
  };
  return { editing, start: () => setEditing(true), field };
}

/**
 * The round-up's big title, renamed in place: click it (or Enter or Space on it) to edit. A name the
 * person gives stays; clearing theirs hands naming back to Claude.
 */
export function RoundUpTitle({
  roundUp,
  onRename,
  titleRef,
  className,
}: {
  roundUp: Pick<RoundUp, 'id' | 'title' | 'titleSource'>;
  onRename: (id: string, title: string) => unknown;
  titleRef?: Ref<HTMLHeadingElement>;
  className?: string;
}) {
  const { editing, start, field } = useTitleEdit(roundUp, onRename);

  return (
    <h1 ref={titleRef} className={className}>
      {editing ? (
        <input
          {...field}
          // The same face and size as the title: renaming does not move anything.
          className="placeholder:text-fa w-full min-w-0 bg-transparent p-0 [font:inherit] tracking-[inherit] outline-none"
        />
      ) : (
        <span
          role="button"
          tabIndex={0}
          title={roundUp.titleSource === 'ai' ? 'Named by Claude · click to rename' : 'Click to rename'}
          onClick={start}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'F2') {
              e.preventDefault();
              start();
            }
          }}
          className="decoration-ln2 cursor-text rounded-md underline-offset-[6px] outline-none hover:underline hover:decoration-dotted focus-visible:underline"
        >
          <FadeText key={roundUp.id} text={titleOf(roundUp)} />
        </span>
      )}
    </h1>
  );
}
