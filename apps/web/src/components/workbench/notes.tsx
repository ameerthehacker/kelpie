import { ArrowUpIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { WorkbenchCard, WorkbenchNote } from '@kelpie/protocol';
import { HarnessMark } from '@/components/harness-mark';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { useCardActions } from '@/hooks/use-workbench';
import { chatWhen, noteFrom, noteState, noteTargets, noteTo } from '@/lib/workbench';
import { cn } from '@/lib/utils';

const EVERYONE = 'everyone';

/** Who wrote a note, at a glance: the agent's harness, or a letter for Kelpie and the person. */
function Author({ note }: { note: WorkbenchNote }) {
  if (note.from.harness) return <HarnessMark harness={note.from.harness} className="size-4" />;
  return (
    <span aria-hidden="true" className={cn('flex size-4 shrink-0 items-center justify-center rounded-md text-[9px] font-semibold', note.from.kind === 'person' ? 'bg-fg text-background' : 'bg-acc text-accfg')}>
      {note.from.kind === 'person' ? 'Y' : 'K'}
    </span>
  );
}

/** One note: who to whom, and what. `compact` keeps it to a line, as on the card. */
export function NoteRow({ note, now, compact }: { note: WorkbenchNote; now: number; compact?: boolean }) {
  const to = noteTo(note);
  const state = noteState(note);
  return (
    <li className={cn('flex gap-2', compact ? 'items-center text-xs' : 'items-start text-[13px]')}>
      <span className={cn(!compact && 'pt-0.5')}>
        <Author note={note} />
      </span>
      {compact ? (
        <p className="text-fg2 min-w-0 flex-1 truncate">
          <span className="text-fg font-medium">{noteFrom(note)}</span>
          {to && <span className="text-mu"> → {to}</span>}
          <span className="text-mu">: </span>
          {note.body}
        </p>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-mu flex items-baseline gap-1.5 text-xs">
            <span className="text-fg font-medium">{noteFrom(note)}</span>
            {to && <span>→ {to}</span>}
            <span className="text-mu2 ml-auto shrink-0">{chatWhen(note.createdAt, now)}</span>
          </p>
          <p className="text-fg2 break-words whitespace-pre-wrap">{note.body}</p>
          {state && <p className="text-mu2 text-[11px]">{state}</p>}
        </div>
      )}
    </li>
  );
}

interface Props {
  card: WorkbenchCard;
  now: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Every note on a card, and a note from the person: to everyone, or to one of the card's agents for its next turn. */
export function NotesSheet({ card, now, open, onOpenChange }: Props) {
  const { note } = useCardActions();
  const targets = noteTargets(card);
  const [to, setTo] = useState(EVERYONE);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // An agent that left the card can't be picked any more.
  const target = targets.some((t) => t.id === to) ? to : EVERYONE;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setSending(true);
    setError(undefined);
    try {
      await note(card.id, body, target === EVERYONE ? undefined : target);
      setText('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="bg-background w-full gap-0 data-[side=right]:sm:max-w-[460px]">
        <SheetHeader className="px-5 pt-5 pb-3">
          <SheetTitle className="font-heading pr-8 text-xl font-semibold tracking-[-0.02em]">Notes on {card.title}</SheetTitle>
          <SheetDescription>What the agents and Kelpie tell each other. A note to an agent reaches it with its next turn; it never interrupts it.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-4">
          {card.notes.length ? (
            <ul className="flex flex-col gap-3.5">
              {card.notes.map((n) => (
                <NoteRow key={n.id} note={n} now={now} />
              ))}
            </ul>
          ) : (
            <p className="text-mu text-[13px]">No notes yet.</p>
          )}
        </div>
        <form onSubmit={send} className="border-ln flex flex-col gap-2 border-t px-5 pt-3 pb-5">
          <div className="flex items-center gap-2">
            <label htmlFor={`note-to-${card.id}`} className="text-mu2 text-xs">
              Note to
            </label>
            <Select value={target} onValueChange={setTo}>
              <SelectTrigger id={`note-to-${card.id}`} size="sm" className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EVERYONE}>Everyone on the card</SelectItem>
                {targets.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="bg-chip flex items-end gap-1.5 rounded-[20px] py-[5px] pr-[5px] pl-3">
            <Textarea
              aria-label="Your note"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Leave a note…"
              rows={1}
              maxLength={2000}
              className="max-h-40 min-h-[34px] resize-none border-0 bg-transparent px-0 py-[7px] shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            <button
              type="submit"
              aria-label="Post the note"
              disabled={sending || !text.trim()}
              className="bg-acc text-accfg flex size-[34px] shrink-0 items-center justify-center rounded-full disabled:opacity-50"
            >
              <ArrowUpIcon className="size-3.5" strokeWidth={2.4} />
            </button>
          </div>
          {error && <p className="text-fail px-1 text-xs">Couldn’t post it: {error}</p>}
        </form>
      </SheetContent>
    </Sheet>
  );
}
