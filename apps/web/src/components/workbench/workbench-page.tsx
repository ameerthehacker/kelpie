import { useEffect, useMemo, useRef, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useApprovals } from '@/hooks/use-approvals';
import { useNow } from '@/hooks/use-now';
import { useWorkbench } from '@/hooks/use-workbench';
import { columns, needsYouTotal, onBoard, STAGES } from '@/lib/workbench';
import { cn } from '@/lib/utils';
import { BoardCard } from './workbench-card';

const FLASH_FOR = 2400;

/**
 * Every feature the person's round-ups are working on, one card each, in columns by stage. Opened
 * at `/workbench/:cardId` (a link an orchestrator shares), it scrolls to that card and marks it.
 */
export function WorkbenchPage({ cardId }: { cardId?: string }) {
  const { cards, error, unavailable } = useWorkbench();
  const approvals = useApprovals();
  const now = useNow();
  const cols = useMemo(() => columns(cards ?? [], now), [cards, now]);
  const shown = STAGES.reduce((n, s) => n + cols[s.stage].length, 0);
  const waiting = needsYouTotal(cards, now);
  const linked = cardId ? cards?.find((c) => c.id === cardId) : undefined;
  const linkedShown = !!linked && onBoard(linked, now);

  // Once per link: the card scrolls into view and takes focus when it is first on the board, then its ring fades.
  const [flash, setFlash] = useState<string | undefined>();
  const scrolledTo = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!cardId || !linkedShown || scrolledTo.current === cardId) return;
    scrolledTo.current = cardId;
    const el = document.getElementById(`card-${cardId}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    el?.focus({ preventScroll: true });
    setFlash(cardId);
  }, [cardId, linkedShown]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(undefined), FLASH_FOR);
    return () => clearTimeout(t);
  }, [flash]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-col gap-1 px-7 pt-1 max-sm:px-4">
        <h1 className="font-heading text-[34px] leading-[1.05] font-semibold tracking-[-0.035em]">Workbench</h1>
        <p className="text-mu text-[13px]">
          {cards === undefined
            ? 'Every feature your round-ups are working on.'
            : `${shown} feature${shown === 1 ? '' : 's'}${waiting ? ` · ${waiting} need${waiting === 1 ? 's' : ''} you` : ''}`}
        </p>
        {error && <p className="text-fail text-sm">Couldn’t load the Workbench: {error}</p>}
        {unavailable ? (
          <p className="text-mu2 text-[13px]">The Workbench isn’t available yet.</p>
        ) : (
          cardId && cards && !linkedShown && <p className="text-mu2 text-[13px]">That card isn’t on the board.</p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex w-max gap-2.5 px-7 pb-7 max-sm:px-4">
          {STAGES.map(({ stage, label, dot }) => {
            const list = cols[stage];
            return (
              <section key={stage} aria-label={label} className="bg-well flex w-[280px] shrink-0 flex-col gap-2.5 rounded-[22px] p-2.5">
                <h2 className="flex h-7 items-center gap-2 px-1.5 text-[13px] font-medium">
                  <span aria-hidden="true" className={cn('size-2 rounded-full', dot)} />
                  {label}
                  <span className="text-mu2 font-mono text-[11px] font-normal">{cards === undefined ? '' : list.length}</span>
                </h2>
                {cards === undefined && !error && <Skeleton className="h-36 rounded-[18px]" />}
                {cards !== undefined && list.length === 0 && <p className="text-mu2 px-1.5 pb-1.5 text-[13px]">Nothing here</p>}
                {list.map((card) => (
                  <BoardCard key={card.id} card={card} approvals={approvals} now={now} linked={card.id === cardId} highlight={flash === card.id} />
                ))}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
