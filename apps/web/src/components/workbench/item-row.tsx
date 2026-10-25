import type { WorkbenchItem } from '@kelpie/protocol';
import { Badge } from '@/components/ui/badge';
import { pillOf } from '@/lib/workbench';
import { cn } from '@/lib/utils';

/** One deliverable on a card: its ref (`#412`), title and a pill for where it stands. */
export function ItemRow({ item }: { item: WorkbenchItem }) {
  const pill = pillOf(item.status);
  const name = (
    <>
      {item.ref && <span className="text-mu mr-1.5">{item.ref}</span>}
      {item.title}
    </>
  );
  return (
    <li className="flex min-h-6 items-center gap-2 text-[13px]" title={item.branch}>
      {item.url ? (
        <a href={item.url} target="_blank" rel="noreferrer" className="text-fg2 min-w-0 flex-1 truncate hover:underline">
          {name}
        </a>
      ) : (
        <span className="text-fg2 min-w-0 flex-1 truncate">{name}</span>
      )}
      <Badge variant="secondary" className={cn('h-5 rounded-full px-2 text-[11px]', pill.className)}>
        {pill.label}
      </Badge>
    </li>
  );
}
