import { ArrowUpIcon, ClipboardListIcon } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { WorkbenchCard } from '@kelpie/protocol';
import { ApprovalTray } from '@/components/approvals/approval-tray';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { useCardActions } from '@/hooks/use-workbench';
import { isPlan, type PendingApproval } from '@/lib/approvals';
import { roundUpPath } from '@/lib/round-ups';

interface Props {
  card: WorkbenchCard;
  /** The open approvals of the card's own agents. */
  approvals: PendingApproval[];
  callout: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** What a card needs from the person, in one place: its callout, its agents' approvals, and a reply to Kelpie. */
export function AnswerSheet({ card, approvals, callout, open, onOpenChange }: Props) {
  const { say } = useCardActions();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const plans = approvals.filter(isPlan);
  useEffect(() => {
    if (!open) {
      setSent(false);
      setError(undefined);
    }
  }, [open]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const message = text.trim();
    if (!message) return;
    setSending(true);
    setError(undefined);
    try {
      await say(card.roundUpId, message);
      setText('');
      setSent(true);
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
          <SheetTitle className="font-heading pr-8 text-xl font-semibold tracking-[-0.02em]">{card.title}</SheetTitle>
          <SheetDescription>
            From the “
            <Link to={roundUpPath(card.roundUpId)} className="hover:text-fg underline-offset-2 hover:underline">
              {card.chat}
            </Link>
            ” chat
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-4">
          {callout && (
            <p className="bg-wbg text-fg rounded-xl px-3 py-2.5 text-[13px] leading-snug">
              <span aria-hidden="true" className="text-wait mr-1.5">
                ◆
              </span>
              {callout}
            </p>
          )}
          {plans.length > 0 && (
            <Link
              to={roundUpPath(card.roundUpId)}
              className="bg-surf border-vio/50 text-fg2 hover:bg-hov flex items-center gap-2 rounded-[20px] border px-4 py-2.5 text-sm"
            >
              <ClipboardListIcon className="text-vio size-4 shrink-0" strokeWidth={2} />A plan is waiting for your approval. Open the chat to review it.
            </Link>
          )}
          <ApprovalTray approvals={approvals} roundUpId={card.roundUpId} />
          {!approvals.length && <p className="text-mu text-[13px]">No approvals are waiting. Reply to Kelpie below.</p>}
        </div>
        <form onSubmit={send} className="border-ln flex flex-col gap-2 border-t px-5 pt-3 pb-5">
          <label htmlFor={`answer-${card.id}`} className="text-mu2 text-xs">
            Reply to Kelpie in this chat
          </label>
          <div className="bg-chip flex items-end gap-1.5 rounded-[20px] py-[5px] pr-[5px] pl-3">
            <Textarea
              id={`answer-${card.id}`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Tell Kelpie what to do…"
              rows={1}
              className="max-h-40 min-h-[34px] resize-none border-0 bg-transparent px-0 py-[7px] shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            <button
              type="submit"
              aria-label="Send to Kelpie"
              disabled={sending || !text.trim()}
              className="bg-acc text-accfg flex size-[34px] shrink-0 items-center justify-center rounded-full disabled:opacity-50"
            >
              <ArrowUpIcon className="size-3.5" strokeWidth={2.4} />
            </button>
          </div>
          {error ? (
            <p className="text-fail px-1 text-xs">Couldn’t send it: {error}</p>
          ) : sent ? (
            <p className="text-mu2 px-1 text-xs">
              Sent.{' '}
              <Link to={roundUpPath(card.roundUpId)} className="text-fg underline-offset-2 hover:underline">
                Open the chat
              </Link>{' '}
              to follow along.
            </p>
          ) : null}
        </form>
      </SheetContent>
    </Sheet>
  );
}
