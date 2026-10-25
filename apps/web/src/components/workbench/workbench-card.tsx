import { ArchiveIcon, MessageCircleIcon, MoreHorizontalIcon, SquareArrowOutUpRightIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { WorkbenchCard } from '@kelpie/protocol';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useCardActions } from '@/hooks/use-workbench';
import type { PendingApproval } from '@/lib/approvals';
import { roundUpPath } from '@/lib/round-ups';
import { calloutOf, cardApprovals, chatWhen, footer, PRIMARY_LABEL, primaryAction, reviewTurn, tally, topItems } from '@/lib/workbench';
import { cn } from '@/lib/utils';
import { AnswerSheet } from './answer-sheet';
import { ItemRow } from './item-row';
import { TicketChips } from './ticket-chip';

const SHOWN = 3;

const ACTION_STYLE = {
  answer: 'bg-fg text-background hover:bg-fg/85',
  review: 'bg-chip text-fg hover:bg-raise',
  merge: 'bg-acc text-accfg hover:bg-acc/85',
} as const;

interface Props {
  card: WorkbenchCard;
  /** Every open approval; the card picks its own agents' out. */
  approvals: PendingApproval[];
  now: number;
  /** Opened by its link: shown with a ring for a moment. */
  highlight?: boolean;
}

/** One feature on the board: where its work stands, what waits on the person, and the one thing to do next. */
export function BoardCard({ card, approvals: all, now, highlight }: Props) {
  const navigate = useNavigate();
  const { archive, merge, say } = useCardActions();
  const approvals = useMemo(() => cardApprovals(card, all), [card, all]);
  const callout = calloutOf(card, approvals);
  const action = primaryAction(card);
  const items = topItems(card.items, SHOWN);
  const more = tally(card.items, SHOWN);
  const foot = footer(card);
  const [answering, setAnswering] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [mergeError, setMergeError] = useState<string | undefined>();
  const chat = roundUpPath(card.roundUpId);

  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
    } catch (err) {
      setError(`Couldn’t ${what}: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const onAction = () => {
    if (action === 'answer') setAnswering(true);
    if (action === 'merge') {
      setMergeError(undefined);
      setConfirming(true);
    }
    if (action === 'review') void run('start the review', () => say(card.roundUpId, reviewTurn(card)).then(() => navigate(chat)));
  };
  const doMerge = async () => {
    setBusy(true);
    setMergeError(undefined);
    try {
      await merge(card.id);
      setConfirming(false);
    } catch (err) {
      setMergeError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      id={`card-${card.id}`}
      aria-label={card.title}
      className={cn(
        'group/card bg-surf border-ln relative flex flex-col gap-3 rounded-[18px] border p-3.5 shadow-[0_1px_2px_rgba(20,30,25,0.04)] transition-shadow duration-500',
        highlight && 'ring-acc ring-2 ring-offset-2 ring-offset-well',
      )}
    >
      <div className="flex flex-col gap-0.5 pr-7">
        <Link to={chat} className="text-fg text-[15px] leading-snug font-medium hover:underline">
          {card.title}
        </Link>
        {card.repo && <span className="text-mu2 truncate font-mono text-[11px]">{card.repo}</span>}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Options for ${card.title}`}
          className="text-mu2 hover:text-fg hover:bg-hov data-[state=open]:text-fg absolute top-2.5 right-2.5 flex size-7 items-center justify-center rounded-lg opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontalIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link to={chat}>
              <SquareArrowOutUpRightIcon /> Open the chat
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void run('remove it', () => archive(card.id))}>
            <ArchiveIcon /> Remove from Workbench
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* A long chat name gives way; the time always shows. */}
      <Link to={chat} className="text-mu hover:text-fg2 flex items-center text-xs whitespace-pre">
        <MessageCircleIcon className="text-mu2 mr-1.5 size-3.5 shrink-0" strokeWidth={1.9} />
        From the “<span className="min-w-0 truncate">{card.chat}</span>” chat · {chatWhen(card.updatedAt, now)}
      </Link>

      <TicketChips tickets={card.tickets} />

      {callout && (
        <p className="bg-wbg text-fg rounded-xl px-3 py-2.5 text-[13px] leading-snug">
          <span aria-hidden="true" className="text-wait mr-1.5">
            ◆
          </span>
          {callout}
        </p>
      )}

      {(items.length > 0 || more) && (
        <div className="flex flex-col gap-1">
          {items.length > 0 && (
            <ul className="flex flex-col gap-1">
              {items.map((i) => (
                <ItemRow key={i.key} item={i} />
              ))}
            </ul>
          )}
          {more && <p className="text-mu pt-0.5 text-xs">{more}</p>}
        </div>
      )}

      <div className="border-ln flex items-center gap-2 border-t pt-3 text-xs">
        <span className="text-mu min-w-0 flex-1 truncate">{foot.agents}</span>
        {foot.needsYou && (
          <span className="text-wait shrink-0 font-medium">
            <span aria-hidden="true">◆ </span>
            {foot.needsYou}
          </span>
        )}
      </div>

      {action && (
        <button type="button" disabled={busy} onClick={onAction} className={cn('h-9 w-full rounded-full text-[13px] font-medium disabled:opacity-60', ACTION_STYLE[action])}>
          {PRIMARY_LABEL[action]}
        </button>
      )}
      {error && <p className="text-fail -mt-1 text-xs">{error}</p>}

      <AnswerSheet card={card} approvals={approvals} callout={callout} open={answering} onOpenChange={setAnswering} />

      <Dialog open={confirming} onOpenChange={(open) => !busy && setConfirming(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge “{card.title}”?</DialogTitle>
            <DialogDescription>
              Kelpie merges {card.branch ? <span className="font-mono">{card.branch}</span> : 'this card’s work'} into{' '}
              {card.base ? <span className="font-mono">{card.base}</span> : 'its base branch'}
              {card.repo ? ` in ${card.repo}` : ''}.
            </DialogDescription>
          </DialogHeader>
          {mergeError && <p className="text-fail text-sm">Couldn’t merge: {mergeError}</p>}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button disabled={busy} onClick={() => void doMerge()}>
              {busy ? 'Merging…' : 'Merge'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}
