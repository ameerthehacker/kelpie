import { ClipboardListIcon } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { useApprovals } from '@/hooks/use-approvals';
import { isPlan } from '@/lib/approvals';
import { roundUpPath, titleOf, type RoundUp } from '@/lib/round-ups';
import { ApprovalTray } from './approval-tray';

/** Everything every round-up is waiting on the person for, in one place, round-up by round-up. */
export function ApprovalsPage({ roundUps }: { roundUps: RoundUp[] | undefined }) {
  const all = useApprovals();
  const byRoundUp = useMemo(() => {
    const m = new Map<string, typeof all>();
    for (const a of all) {
      const list = m.get(a.roundUpId);
      if (list) list.push(a);
      else m.set(a.roundUpId, [a]);
    }
    return m;
  }, [all]);

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 overflow-y-auto px-7 pt-2 pb-10 max-sm:px-4">
      <h1 className="font-heading text-[34px] leading-[1.05] font-semibold tracking-[-0.035em]">Waiting on you</h1>
      {byRoundUp.size === 0 && <p className="text-mu">Nothing is waiting: no agent needs your approval right now.</p>}
      {[...byRoundUp].map(([roundUpId, approvals]) => {
        const roundUp = roundUps?.find((r) => r.id === roundUpId);
        const plans = approvals.filter(isPlan);
        return (
          <section key={roundUpId} className="flex flex-col gap-2">
            <Link to={roundUpPath(roundUpId)} className="text-fg w-fit text-[15px] font-medium hover:underline">
              {roundUp ? titleOf(roundUp) : 'Round-up'}
            </Link>
            {plans.length > 0 && (
              <Link to={roundUpPath(roundUpId)} className="bg-surf border-vio/50 text-fg2 hover:bg-hov flex items-center gap-2 rounded-[20px] border px-4 py-2.5 text-sm">
                <ClipboardListIcon className="text-vio size-4" strokeWidth={2} />A plan is waiting for your approval. Open the round-up to review it.
              </Link>
            )}
            <ApprovalTray approvals={approvals} roundUpId={roundUpId} />
          </section>
        );
      })}
    </div>
  );
}
