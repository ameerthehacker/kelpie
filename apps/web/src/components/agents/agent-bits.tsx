import type { TodoItem } from '@kelpie/protocol';
import type { AgentStatus } from '@/lib/agents';
import { cn } from '@/lib/utils';

/** A small status dot: pulsing blue while working, green when done, red on failure, a ring otherwise. */
export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-[7px] shrink-0 rounded-full',
        status === 'working' && 'animate-pulse bg-blue-500',
        status === 'done' && 'bg-green-500',
        status === 'failed' && 'bg-destructive',
        (status === 'stopped' || status === 'idle') && 'border-muted-foreground border-[1.5px]',
        className,
      )}
    />
  );
}

const TODO_MARK: Record<TodoItem['status'], string> = { completed: '✓', in_progress: '›', pending: '·' };

/** A todo list: ✓ done (struck through), › in progress (in its active wording), · to do. */
export function TodoList({ todos, label, className }: { todos: TodoItem[]; label?: string; className?: string }) {
  return (
    <ul aria-label={label} className={cn('flex flex-col gap-0.5', className)}>
      {todos.map((t) => (
        <li
          key={t.id}
          className={cn(
            'flex items-baseline gap-2 text-[13px]',
            t.status === 'in_progress' ? 'text-foreground' : 'text-muted-foreground',
            t.status === 'completed' && 'decoration-muted-foreground/50 line-through',
          )}
        >
          <span className="w-2.5 shrink-0 font-mono">{TODO_MARK[t.status]}</span>
          <span className="min-w-0">{t.status === 'in_progress' ? (t.activeText ?? t.text) : t.text}</span>
        </li>
      ))}
    </ul>
  );
}
