import { CheckIcon, ChevronRightIcon, UserIcon } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { MessageResponse } from '@/components/ai-elements/message';
import { HarnessMark } from '@/components/harness-mark';
import { KelpieLogo } from '@/components/shell/brand';
import { useOpenSession } from '@/hooks/use-open-session';
import { useReview } from '@/hooks/use-review';
import { authorLabel, type ReviewComment, type ReviewThread } from '@/lib/review';
import { cn } from '@/lib/utils';

export const pill = 'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] disabled:opacity-50';
export const quietButton = cn(pill, 'bg-chip text-fg2 hover:bg-raise');
export const primaryButton = cn(pill, 'bg-acc text-accfg');

/**
 * A comment being written: a new thread's first comment, a reply, or an edit. `onSubmit` throws
 * to keep the text; its message is shown under the box.
 */
export function CommentBox({
  placeholder,
  submitLabel = 'Add to review',
  initial = '',
  autoFocus,
  onSubmit,
  onCancel,
  onTextChange,
  className,
}: {
  placeholder: string;
  submitLabel?: string;
  initial?: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<unknown>;
  onCancel?: () => void;
  /** Every edit, so whoever opened the box can keep what was written if the box has to move. */
  onTextChange?: (text: string) => void;
  className?: string;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(body);
      setText('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={send} className={cn('border-acc bg-background flex flex-col gap-2 rounded-xl border px-3.5 pt-3 pb-2.5 font-sans', className)}>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onTextChange?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
          // Esc leaves the box, not the full-screen view around it.
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel?.();
          }
        }}
        autoFocus={autoFocus}
        maxLength={10_000}
        rows={3}
        aria-label={placeholder}
        placeholder={placeholder}
        className="text-fg placeholder:text-ph min-h-16 w-full resize-y bg-transparent text-sm leading-[1.45] outline-none"
      />
      {error && <p className="text-fail text-xs">{error}</p>}
      <div className="flex items-center justify-end gap-1.5">
        {onCancel && (
          <button type="button" onClick={onCancel} className={cn(pill, 'text-mu hover:text-fg')}>
            Cancel
          </button>
        )}
        <button type="submit" disabled={!text.trim() || busy} className={primaryButton}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/** The harness an agent's reply was written with: its session's, else the thread's agent of that id. */
function harnessOf(c: ReviewComment, t: ReviewThread): string {
  if (c.authorHarness) return c.authorHarness;
  return [t.assignedTo, t.agent].find((a) => a?.id && a.id === c.authorId)?.harness ?? 'claude-code';
}

/** Who wrote a comment, at a glance: the person's neutral circle, Kelpie's mark, or the agent's harness. */
function Avatar({ comment: c, thread }: { comment: ReviewComment; thread: ReviewThread }) {
  if (c.author === 'orchestrator') return <KelpieLogo className="size-5" />;
  if (c.author === 'agent') return <HarnessMark harness={harnessOf(c, thread)} className="size-5" />;
  return (
    <span aria-hidden="true" className="bg-chip text-mu inline-flex size-5 shrink-0 items-center justify-center rounded-full">
      <UserIcon className="size-3" strokeWidth={2.2} />
    </span>
  );
}

/** One comment: who, and what; the person's own unsent comments can still be edited or deleted. Agents' replies sit on a faint tint. */
function Comment({ comment: c, thread, roundUpId }: { comment: ReviewComment; thread: ReviewThread; roundUpId: string }) {
  const review = useReview(roundUpId);
  const openSession = useOpenSession();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const pending = c.state === 'pending';
  if (editing)
    return (
      <CommentBox
        placeholder="Edit comment"
        submitLabel="Save"
        initial={c.body}
        autoFocus
        onCancel={() => setEditing(false)}
        onSubmit={async (body) => {
          await review.edit({ id: c.id, body });
          setEditing(false);
        }}
      />
    );
  const byAgent = c.author !== 'person';
  const agentId = c.author === 'agent' ? c.authorId : undefined;
  return (
    <div className={cn('flex gap-2.5', byAgent && 'bg-well dark:bg-raise -mx-2 rounded-lg p-2')}>
      <Avatar comment={c} thread={thread} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-mu2 flex min-h-5 items-center gap-2 text-xs">
          {agentId ? (
            <button type="button" onClick={() => openSession(agentId)} title={`Open ${authorLabel(c)}`} className="text-fg truncate font-semibold hover:underline">
              {authorLabel(c)}
            </button>
          ) : (
            <span className={cn('text-fg truncate', byAgent ? 'font-semibold' : 'font-medium')}>{authorLabel(c)}</span>
          )}
          {pending && <span className="bg-wbg text-wait rounded-full px-1.5 py-px text-[10px] font-medium">Pending</span>}
          {pending && (
            <span className="ml-auto flex gap-2">
              <button type="button" onClick={() => setEditing(true)} className="hover:text-fg">
                Edit
              </button>
              <button type="button" onClick={() => review.remove(c.id).catch((err: Error) => setError(err.message))} className="hover:text-fail">
                Delete
              </button>
            </span>
          )}
        </div>
        <div className="text-fg text-sm leading-[1.45] break-words [&>*>:first-child]:mt-0 [&>*>:last-child]:mb-0">
          <MessageResponse>{c.body}</MessageResponse>
        </div>
        {error && <p className="text-fail text-xs">{error}</p>}
      </div>
    </div>
  );
}

/** Who resolved a thread: the person, or the agent (by the thread's agents' titles when known). */
function resolver(t: ReviewThread): string {
  if (t.resolvedBy === 'person') return 'you';
  if (t.resolvedBy && t.assignedTo?.id === t.resolvedBy) return t.assignedTo.title;
  if (t.resolvedBy && t.agent?.id === t.resolvedBy) return t.agent.title;
  const by = [...t.comments].reverse().find((c) => c.authorId === t.resolvedBy);
  return by ? authorLabel(by) : 'an agent';
}

/** A thread: its comments, a reply (into the review), and resolve. Resolved ones fold to a line. */
export function ThreadView({ thread: t, roundUpId, showHunk }: { thread: ReviewThread; roundUpId: string; showHunk?: boolean }) {
  const review = useReview(roundUpId);
  const resolved = t.status === 'resolved';
  const [open, setOpen] = useState(!resolved);
  const [replying, setReplying] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // A thread resolved live (by an agent) folds away; one reopened unfolds.
  const [was, setWas] = useState(t.status);
  if (was !== t.status) {
    setWas(t.status);
    setOpen(t.status !== 'resolved');
  }
  const toggle = () =>
    review.resolve({ threadId: t.id, resolved: !resolved }).catch((err: Error) => setError(`Couldn't ${resolved ? 'reopen' : 'resolve'} the thread: ${err.message}`));
  const first = t.comments[0];

  return (
    <div className="bg-surf border-ln2 flex flex-col overflow-hidden rounded-xl border font-sans" data-thread={t.id}>
      {resolved && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="text-mu hover:bg-hov flex h-9 items-center gap-2 px-3 text-left text-xs">
          <ChevronRightIcon className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} strokeWidth={2.4} />
          <CheckIcon className="text-done size-3.5 shrink-0" strokeWidth={2.4} />
          <span className="shrink-0">Resolved by {resolver(t)}</span>
          {!open && first && <span className="text-mu2 min-w-0 truncate">· {first.body}</span>}
          {t.outdated && <OutdatedBadge className="ml-auto" />}
        </button>
      )}
      {open && (
        <div className={cn('flex flex-col gap-3 px-3.5 pb-3', resolved ? 'pt-1' : 'pt-3')}>
          {!resolved && (t.outdated || t.assignedTo) && (
            <div className="text-mu2 flex items-center gap-2 text-xs">
              {t.outdated && <OutdatedBadge />}
              {t.assignedTo && <span>With {t.assignedTo.title}</span>}
            </div>
          )}
          {showHunk && <HunkExcerpt hunk={t.diffHunk} />}
          {t.comments.map((c) => (
            <Comment key={c.id} comment={c} thread={t} roundUpId={roundUpId} />
          ))}
          {replying ? (
            <CommentBox
              placeholder="Reply…"
              autoFocus
              onCancel={() => setReplying(false)}
              onSubmit={async (body) => {
                await review.comment({ threadId: t.id, body });
                setReplying(false);
              }}
            />
          ) : (
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => setReplying(true)} className="bg-chip text-mu hover:text-fg h-8 flex-1 rounded-full px-3.5 text-left text-[13px]">
                Reply…
              </button>
              {t.status !== 'pending' && (
                <button type="button" onClick={toggle} className={quietButton}>
                  {resolved ? 'Unresolve' : 'Resolve'}
                </button>
              )}
            </div>
          )}
          {error && <p className="text-fail text-xs">{error}</p>}
        </div>
      )}
    </div>
  );
}

export function OutdatedBadge({ className }: { className?: string }) {
  return (
    <span title="The line has changed since this comment" className={cn('bg-wbg text-wait rounded-full px-2 py-px text-[11px] font-medium', className)}>
      Outdated
    </span>
  );
}

/** The few lines a thread was made on, as they were then. */
function HunkExcerpt({ hunk }: { hunk: string }) {
  const lines = hunk.split('\n').filter((l, i, all) => l || i < all.length - 1);
  return (
    <pre className="bg-well text-fg2 overflow-x-auto rounded-lg px-3 py-2 font-mono text-[11.5px] leading-[1.55]">
      {lines.map((l, i) => (
        <div key={i} className={cn(l.startsWith('@@') ? 'text-mu2' : l.startsWith('+') ? 'text-done' : l.startsWith('-') ? 'text-fail' : undefined, i === lines.length - 1 && 'font-semibold')}>
          {l || ' '}
        </div>
      ))}
    </pre>
  );
}

/** Threads that are not on a line the diff shows: outdated, or the diff moved on around them. Above the file's diff. */
export function ThreadStrip({ threads, roundUpId, children }: { threads: ReviewThread[]; roundUpId: string; children?: ReactNode }) {
  if (!threads.length) return null;
  return (
    <div className="bg-well border-ln flex flex-col gap-2 border-b px-3 py-3">
      {children}
      {threads.map((t) => (
        <div key={t.id} className="flex flex-col gap-1">
          <span className="text-mu2 font-mono text-[11px]">
            {t.side === 'deletions' ? 'Removed line' : 'Line'} {t.line}
          </span>
          <ThreadView thread={t} roundUpId={roundUpId} showHunk />
        </div>
      ))}
    </div>
  );
}
