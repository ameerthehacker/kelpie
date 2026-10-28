import { CheckIcon, CodeXmlIcon, DiffIcon, FileTextIcon, Maximize2Icon } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { artifactKey, type ArtifactAuthor, type ArtifactRef } from '@kelpie/protocol';
import { MessageResponse } from '@/components/ai-elements/message';
import { StatusDot } from '@/components/agents/agent-bits';
import { useAgentPane } from '@/components/agents/pane-state';
import { AgentChanges } from '@/components/changes/agent-changes';
import { primaryButton, quietButton } from '@/components/changes/thread';
import { HarnessMark } from '@/components/harness-mark';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useAgents } from '@/hooks/use-agents';
import { useAcceptArtifact, useArtifactDocument, useArtifacts } from '@/hooks/use-artifacts';
import { useChanges } from '@/hooks/use-changes';
import { useNow } from '@/hooks/use-now';
import type { AgentSummary } from '@/lib/agents';
import { api } from '@/lib/api';
import { askTurn, fileName } from '@/lib/artifacts';
import { vscodeUrl } from '@/lib/changes';
import { chatWhen } from '@/lib/workbench';
import { cn } from '@/lib/utils';

/** The pills on an artifact's header: a document or code changes the person has yet to accept, or has. */
export function ReviewPill({ accepted, className }: { accepted: boolean; className?: string }) {
  return (
    <span className={cn('bg-chip inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium', accepted ? 'text-done' : 'text-acc', className)}>
      {accepted && <CheckIcon aria-hidden="true" className="size-3" strokeWidth={2.4} />}
      {accepted ? 'Accepted' : 'Ready for review'}
    </span>
  );
}

/** An artifact's tile: a green page for a document, a blue ± for code changes. */
export function ArtifactIcon({ kind, className }: { kind: ArtifactRef['kind']; className?: string }) {
  const Icon = kind === 'document' ? FileTextIcon : DiffIcon;
  return (
    <span aria-hidden="true" className={cn('bg-chip flex size-8 shrink-0 items-center justify-center rounded-lg', kind === 'document' ? 'text-acc' : 'text-run', className)}>
      <Icon className="size-4" />
    </span>
  );
}

/** An open artifact's pill in the pane's tab strip: its title, with its agent's status for code changes. */
export function ArtifactTabLabel({ roundUpId, artifact, agents }: { roundUpId: string; artifact: ArtifactRef; agents: Map<string, AgentSummary> }) {
  const docs = useArtifacts(roundUpId).data?.documents;
  if (artifact.kind === 'document') return <span className="truncate">{docs?.find((d) => d.path === artifact.path)?.title ?? fileName(artifact.path)}</span>;
  const a = agents.get(artifact.agentId);
  return (
    <>
      {a && <StatusDot status={a.status} />}
      <span className="truncate">{a ? `${a.title} changes` : 'Code changes'}</span>
    </>
  );
}

const pill = 'bg-chip text-fg2 hover:bg-raise inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px]';

/** Who an artifact is from, for its type line and its footer: an agent, or Kelpie. */
interface Author {
  title: string;
  harness?: string;
  /** Where "Ask for changes" goes: the agent, or the round-up (its orchestrator). */
  sessionId: string;
}

/** "Document from [CC] Schema migration · 10:46". */
function TypeLine({ type, author, at }: { type: string; author?: Author; at?: number }) {
  const now = useNow(60_000);
  return (
    <p className="text-mu flex min-w-0 items-center gap-1.5 text-xs">
      <span className="shrink-0">{type}</span>
      {author && (
        <>
          <span className="shrink-0">from</span>
          {author.harness && <HarnessMark harness={author.harness} className="size-4" />}
          <span className="text-fg2 truncate">{author.title}</span>
        </>
      )}
      {at !== undefined && <span className="shrink-0">· {chatWhen(at, now)}</span>}
    </p>
  );
}

/**
 * An artifact in the side panel: what it is and who it is from, its body (a rendered document, or
 * an agent's diff), and a line back to its author with Accept. Opened with `useOpenArtifact`.
 */
export function ArtifactDetail({ roundUpId, artifact }: { roundUpId: string; artifact: ArtifactRef }) {
  return artifact.kind === 'document' ? <DocumentDetail roundUpId={roundUpId} path={artifact.path} /> : <ChangesDetail roundUpId={roundUpId} agentId={artifact.agentId} />;
}

const authorOf = (roundUpId: string, a: ArtifactAuthor | undefined): Author =>
  a?.kind === 'agent' && a.agentId ? { title: a.title, harness: a.harness, sessionId: a.agentId } : { title: 'Kelpie', sessionId: roundUpId };

function DocumentDetail({ roundUpId, path }: { roundUpId: string; path: string }) {
  const doc = useArtifactDocument(roundUpId, path);
  const listed = useArtifacts(roundUpId).data?.documents.find((d) => d.path === path);
  const [full, setFull] = useState(false);
  const d = doc.data;
  const author = authorOf(roundUpId, (listed ?? d)?.author);
  const accepted = !!(listed ?? d)?.acceptedAt;
  const title = listed?.title ?? d?.title ?? fileName(path);
  const body = d && (
    <>
      <MessageResponse>{d.text}</MessageResponse>
      {d.truncated && <p className="text-mu mt-4 text-xs">Only the first megabyte is shown. Open it in VS Code for the rest.</p>}
    </>
  );

  return (
    <DetailFrame
      head={
        <>
          <TypeLine type="Document" author={(listed ?? d)?.author ? author : undefined} at={(listed ?? d)?.updatedAt} />
          <h2 className="text-fg text-[22px] leading-tight font-semibold tracking-[-0.01em] break-words">{title}</h2>
          <div className="flex flex-wrap items-center gap-1.5">
            <ReviewPill accepted={accepted} />
            {d && (
              <a href={vscodeUrl(d.file)} className={pill}>
                <CodeXmlIcon className="size-3" />
                Open in VS Code
              </a>
            )}
            <button type="button" disabled={!d} onClick={() => setFull(true)} className={cn(pill, 'disabled:opacity-50')}>
              <Maximize2Icon className="size-3" />
              Full screen
            </button>
            <span className="text-mu2 min-w-0 truncate font-mono text-[11px]" title={path}>
              {path}
            </span>
          </div>
        </>
      }
      footer={
        <AskFooter
          roundUpId={roundUpId}
          author={author}
          about={d && { kind: 'document', file: d.file }}
          // Accepted as shown: the version on screen, which the daemon refuses once it is rewritten.
          accept={d && { key: artifactKey({ kind: 'document', path }), seen: d.updatedAt }}
          accepted={accepted}
        />
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-1 pb-5 text-sm">
        {doc.error && <p className="text-fail text-sm">Couldn't load the document: {doc.error.message}</p>}
        {!d && !doc.error && <p className="text-mu text-sm">Loading…</p>}
        {body}
      </div>
      <Dialog open={full} onOpenChange={setFull}>
        <DialogContent className="flex max-h-[90dvh] flex-col gap-4 sm:max-w-3xl">
          <DialogTitle>{title}</DialogTitle>
          <div className="min-h-0 overflow-y-auto text-sm">{body}</div>
        </DialogContent>
      </Dialog>
    </DetailFrame>
  );
}

function ChangesDetail({ roundUpId, agentId }: { roundUpId: string; agentId: string }) {
  const paneAgents = useAgentPane()?.agents;
  const listed = useAgents(roundUpId);
  const a = (paneAgents?.length ? paneAgents : listed)?.find((x) => x.id === agentId);
  const changes = useChanges(a?.id, { patches: false, working: a?.status === 'working' }).data;
  const accepted = useArtifacts(roundUpId).data?.accepted;
  const head = changes?.headSha;
  const key = head ? artifactKey({ kind: 'changes', agentId }, head) : undefined;
  const code = vscodeUrl(changes?.checkoutPath);
  if (!a) return <p className="text-mu px-[22px] pt-4 text-sm">{listed ? 'This agent is gone.' : 'Loading…'}</p>;
  const author: Author = { title: a.title, harness: a.harness, sessionId: a.id };
  // Accepted by commit: while the agent works, or has edits it hasn't committed, they are still moving.
  const moving = a.status === 'working' ? `${a.title} is still working on them` : changes?.dirty ? `${a.title} has changes it hasn't committed yet` : undefined;
  const isAccepted = !moving && !!key && !!accepted?.[key];

  return (
    <DetailFrame
      head={
        <>
          <TypeLine type="Code changes" author={author} at={a.updatedAt} />
          <h2 className="text-fg text-[22px] leading-tight font-semibold tracking-[-0.01em] break-words">{a.title}</h2>
          <div className="flex flex-wrap items-center gap-1.5">
            <ReviewPill accepted={isAccepted} />
            {code && (
              <a href={code} className={pill}>
                <CodeXmlIcon className="size-3" />
                Open in VS Code
              </a>
            )}
          </div>
          {/* Full screen is on the diff's own bar, below. */}
          <p className="text-mu2 text-xs">Click any line to leave {a.title} a comment on it.</p>
        </>
      }
      footer={<AskFooter roundUpId={roundUpId} author={author} about={{ kind: 'changes' }} accept={key && !moving ? { key } : undefined} notYet={moving} accepted={isAccepted} />}
    >
      <AgentChanges agent={a} />
    </DetailFrame>
  );
}

function DetailFrame({ head, footer, children }: { head: ReactNode; footer: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-2 px-[22px] pt-4 pb-3">{head}</header>
      {children}
      {footer}
    </div>
  );
}

/**
 * "Ask <author> for changes": a message straight to the agent (or, for Kelpie's own documents, to
 * the round-up), naming what it is about. Accept records the person's Accept.
 */
function AskFooter({
  roundUpId,
  author,
  about,
  accept: acceptable,
  notYet,
  accepted,
}: {
  roundUpId: string;
  author: Author;
  about: Parameters<typeof askTurn>[0] | undefined;
  /** What Accept records (see `useAcceptArtifact`); undefined while it can't be accepted (loading, or `notYet`). */
  accept: { key: string; seen?: number } | undefined;
  /** Why it can't be accepted yet, if it can't. */
  notYet?: string | undefined;
  accepted: boolean;
}) {
  const accept = useAcceptArtifact(roundUpId);
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error?: boolean; text: string } | undefined>();

  const run = async (f: () => Promise<unknown>, done: string, what: string) => {
    setBusy(true);
    setNote(undefined);
    try {
      await f();
      setNote({ text: done });
    } catch (err) {
      setNote({ error: true, text: `Couldn't ${what}: ${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  };
  const ask = (e: FormEvent) => {
    e.preventDefault();
    const message = text.trim();
    if (!message || !about) return;
    void run(
      async () => {
        await api('POST', `/api/sessions/${author.sessionId}/messages`, { text: askTurn(about, message) });
        setText('');
      },
      `Sent to ${author.title}.`,
      'send it',
    );
  };

  return (
    <form onSubmit={ask} className="border-ln flex shrink-0 flex-col gap-2 border-t px-3.5 pt-2.5 pb-3.5">
      <label htmlFor={id} className="sr-only">
        Ask {author.title} for changes
      </label>
      <input
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Ask ${author.title} for changes`}
        className="bg-chip text-fg h-[38px] min-w-0 rounded-full px-4 text-sm outline-none"
      />
      <div className="flex items-center gap-2">
        <p className={cn('min-w-0 flex-1 truncate px-2 text-xs', note?.error ? 'text-fail' : 'text-mu2')}>
          {note?.text ?? (notYet && !accepted ? `Accept once they settle: ${notYet}.` : `Goes straight to ${author.title}.`)}
        </p>
        <button type="submit" disabled={busy || !text.trim() || !about} className={cn(quietButton, 'bg-background border-ln hover:bg-hov border')}>
          Ask for changes
        </button>
        <button
          type="button"
          disabled={busy || !acceptable || accepted}
          onClick={() => acceptable && void run(() => accept(acceptable.key, acceptable.seen), 'Accepted.', 'accept it')}
          title={accepted ? undefined : notYet}
          className={primaryButton}
        >
          {accepted ? 'Accepted' : 'Accept'}
        </button>
      </div>
    </form>
  );
}
