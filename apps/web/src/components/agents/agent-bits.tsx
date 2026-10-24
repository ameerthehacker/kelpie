import type { TodoItem } from '@kelpie/protocol';
import type { AgentStatus } from '@/lib/agents';
import { cn } from '@/lib/utils';

/** The design's status marks: a pulsing dot while working, a solid one when done or failed, a ring otherwise. */
export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-[7px] shrink-0 rounded-full',
        status === 'working' && 'bg-run animate-k-pulse',
        status === 'done' && 'bg-done',
        status === 'failed' && 'bg-fail',
        (status === 'stopped' || status === 'idle') && 'border-mu2 border-[1.5px]',
        className,
      )}
    />
  );
}

const BOX: Record<TodoItem['status'], string> = {
  completed: 'bg-raise text-mu',
  in_progress: 'shadow-[inset_0_0_0_1.5px_var(--run)]',
  pending: 'shadow-[inset_0_0_0_1.5px_var(--bd)]',
};

/** A todo list in the design's marks: a filled ✓ when done, a blue ring in progress, a grey ring to do. */
export function TodoList({ todos, label, className }: { todos: TodoItem[]; label?: string; className?: string }) {
  return (
    <ul aria-label={label} className={cn('flex flex-col gap-1.5', className)}>
      {todos.map((t) => (
        <li key={t.id} className={cn('flex items-center gap-2.5 text-[13px] leading-snug', t.status === 'in_progress' ? 'text-fg' : 'text-mu')}>
          <span aria-hidden="true" className={cn('inline-flex size-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold', BOX[t.status])}>
            {t.status === 'completed' ? '✓' : ''}
          </span>
          <span className="sr-only">{t.status === 'completed' ? 'Done: ' : t.status === 'in_progress' ? 'In progress: ' : 'To do: '}</span>
          <span className="min-w-0">{t.status === 'in_progress' ? (t.activeText ?? t.text) : t.text}</span>
        </li>
      ))}
    </ul>
  );
}
