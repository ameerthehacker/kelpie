import { useEffect, useRef, useState, type Ref } from 'react';
import { renameTo, titleOf, type RoundUp } from '../../lib/round-ups.js';
import { cn } from '../../lib/utils.js';

/**
 * Text that fades in when it changes in place (a round-up named by Claude), keeping its box: no
 * fade on first render, none with reduced motion.
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
 * The round-up's big title, renamed in place: click it (or Enter on it) to edit, Enter saves,
 * Escape cancels, leaving the field saves. A name the person gives stays; clearing theirs hands
 * naming back to Claude.
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
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const title = titleOf(roundUp);

  useEffect(() => {
    if (!editing) return;
    input.current?.focus();
    input.current?.select();
  }, [editing]);

  const finish = (save: boolean) => {
    const next = save && input.current ? renameTo(roundUp, input.current.value) : undefined;
    setEditing(false);
    if (next !== undefined) void onRename(roundUp.id, next);
  };

  return (
    <h1 ref={titleRef} className={className}>
      {editing ? (
        <input
          ref={input}
          aria-label="Round-up title"
          defaultValue={roundUp.title}
          placeholder={roundUp.titleSource === 'person' ? 'Clear to let Claude name it' : title}
          maxLength={200}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              finish(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              finish(false);
            }
          }}
          // The same face and size as the title: renaming does not move anything.
          className="placeholder:text-fa w-full min-w-0 bg-transparent p-0 [font:inherit] tracking-[inherit] outline-none"
        />
      ) : (
        <span
          role="button"
          tabIndex={0}
          title={roundUp.titleSource === 'ai' ? 'Named by Claude · click to rename' : 'Click to rename'}
          onClick={() => setEditing(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'F2') {
              e.preventDefault();
              setEditing(true);
            }
          }}
          className="decoration-ln2 cursor-text rounded-md underline-offset-[6px] outline-none hover:underline hover:decoration-dotted focus-visible:underline"
        >
          <FadeText text={title} />
        </span>
      )}
    </h1>
  );
}
