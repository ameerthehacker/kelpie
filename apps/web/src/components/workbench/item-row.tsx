import type { WorkbenchItem } from '@kelpie/protocol';
import { Badge } from '@/components/ui/badge';
import { HarnessMark } from '@/components/harness-mark';
import { entryOf, pillOf } from '@/lib/workbench';
import { cn } from '@/lib/utils';

/**
 * One deliverable on a card: its agent's harness, ref (`#412`), title and a pill for where it
 * stands; under it, what the agent says it is on (focus, the files it claims, a blocker).
 */
export function ItemRow({ item }: { item: WorkbenchItem }) {
  const pill = pillOf(item.status);
  const entry = entryOf(item);
  const name = (
    <>
      {item.ref && <span className="text-mu mr-1.5">{item.ref}</span>}
      {item.title}
    </>
  );
  return (
    <li className="flex flex-col gap-0.5" title={item.branch}>
      <div className="flex min-h-6 items-center gap-2 text-[13px]">
        {item.harness && <HarnessMark harness={item.harness} className="size-4" />}
        {item.url ? (
          <a href={item.url} target="_blank" rel="noreferrer" className="text-fg2 min-w-0 flex-1 truncate hover:underline">
            {name}
          </a>
        ) : (
          <span className="text-fg2 min-w-0 flex-1 truncate">{name}</span>
        )}
        {item.agentStatus === 'working' && <span aria-label="Working" className="bg-run size-1.5 shrink-0 animate-pulse rounded-full" />}
        <Badge variant="secondary" className={cn('h-5 rounded-full px-2 text-[11px]', pill.className)}>
          {pill.label}
        </Badge>
      </div>
      {entry && (
        <div className={cn('flex flex-col gap-0.5 text-xs', item.harness && 'pl-6')}>
          {entry.focus && <p className="text-mu truncate">{entry.focus}</p>}
          {entry.claims.length > 0 && (
            <p className="flex min-w-0 items-center gap-1" aria-label="Claims">
              {entry.claims.map((c) => (
                <span key={c} className="bg-chip text-fg3 max-w-[11rem] truncate rounded-md px-1.5 py-px font-mono text-[10.5px]">
                  {c}
                </span>
              ))}
              {entry.more > 0 && <span className="text-mu2 shrink-0 text-[11px]">+{entry.more}</span>}
            </p>
          )}
          {entry.blocker && (
            <p className="text-fail truncate">
              <span aria-hidden="true">◆ </span>Blocked: {entry.blocker}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
