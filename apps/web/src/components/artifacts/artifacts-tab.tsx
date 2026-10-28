import { ChevronDownIcon, CodeXmlIcon, ExternalLinkIcon } from 'lucide-react';
import { useState } from 'react';
import type { ArtifactDocument } from '@kelpie/protocol';
import { useAgentPane, useArtifactOpen, useOpenArtifact } from '@/components/agents/pane-state';
import { Totals } from '@/components/changes/changes-tab';
import { quietButton } from '@/components/changes/thread';
import { HarnessMark } from '@/components/harness-mark';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useArtifacts } from '@/hooks/use-artifacts';
import { useChanges } from '@/hooks/use-changes';
import { useCardActions, useWorkbench } from '@/hooks/use-workbench';
import { approveTurn, linkLabel, prSummary, pullRequestsOf, type PullRequest } from '@/lib/artifacts';
import { filesLabel, vscodeUrl } from '@/lib/changes';
import { pillOf } from '@/lib/workbench';
import { cn } from '@/lib/utils';
import { ArtifactIcon, ReviewPill } from './artifact-detail';

/** Pull requests listed before "Show all". */
const PR_SHOWN = 5;
const card = 'bg-surf border-ln rounded-xl border';

/**
 * A round-up's Artifacts tab: the documents its agents left in its scratch folder, and the pull
 * requests on its Workbench cards. A document opens in the side panel.
 */
export function ArtifactsTab({ roundUpId }: { roundUpId: string }) {
  const artifacts = useArtifacts(roundUpId);
  const prs = pullRequestsOf(useWorkbench().cards, roundUpId);
  const documents = artifacts.data?.documents ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[600px] flex-col gap-8">
      {artifacts.error && <p className="text-fail text-sm">Couldn't load the documents: {artifacts.error.message}</p>}
      {documents.length > 0 && (
        <section aria-labelledby="artifacts-documents" className="flex flex-col gap-2.5">
          <h2 id="artifacts-documents" className="flex items-baseline gap-2 text-[15px] font-semibold">
            Documents <span className="text-mu2 font-mono text-xs font-normal">{documents.length}</span>
          </h2>
          <ul className="flex flex-col gap-2">
            {documents.map((d) => (
              <DocumentRow key={d.path} doc={d} />
            ))}
          </ul>
        </section>
      )}
      <PullRequests prs={prs} />
    </div>
  );
}

function DocumentRow({ doc: d }: { doc: ArtifactDocument }) {
  const open = useOpenArtifact();
  const ref = { kind: 'document', path: d.path } as const;
  const selected = useArtifactOpen(ref);
  return (
    <li>
      <button
        type="button"
        onClick={() => open(ref)}
        aria-current={selected || undefined}
        className={cn(card, 'flex w-full items-center gap-3 px-3.5 py-3 text-left', selected ? 'bg-raise' : 'hover:bg-hov')}
      >
        <ArtifactIcon kind="document" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-fg truncate text-sm font-medium">{d.title}</span>
          <span className="text-mu truncate text-xs">
            {d.author ? `${d.author.title} · ` : ''}Document · <span className="font-mono text-[11px]">{d.path}</span>
          </span>
        </span>
        <ReviewPill accepted={!!d.acceptedAt} />
      </button>
    </li>
  );
}

function PullRequests({ prs }: { prs: PullRequest[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? prs.length : Math.min(prs.length, PR_SHOWN);
  return (
    <section aria-labelledby="artifacts-prs" className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2">
        <h2 id="artifacts-prs" className="flex shrink-0 items-baseline gap-2 text-[15px] font-semibold">
          Pull requests <span className="text-mu2 font-mono text-xs font-normal">{prs.length}</span>
        </h2>
        <span className="flex-1" />
        {prs.length > 0 && <span className="text-mu2 min-w-0 truncate text-right text-xs">{prSummary(prs, shown)}</span>}
      </div>
      {prs.length === 0 ? (
        <p className="bg-well text-mu rounded-xl px-4 py-8 text-center text-sm">No pull requests yet. Agents open them as their work lands.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {prs.slice(0, shown).map((pr) => (
            <PullRequestRow key={`${pr.card.id}:${pr.item.key}`} pr={pr} />
          ))}
        </ul>
      )}
      {prs.length > PR_SHOWN && (
        <button type="button" onClick={() => setAll((v) => !v)} className="text-mu hover:text-fg self-start text-xs">
          {all ? 'Show fewer' : `Show all ${prs.length}`}
        </button>
      )}
    </section>
  );
}

/**
 * One deliverable: where it stands, whose it is and what it changed; opened, who reviews it and
 * what the person can do. Its diff is only fetched once it is opened: a round-up may have hundreds.
 */
function PullRequestRow({ pr }: { pr: PullRequest }) {
  const { item, card: c } = pr;
  const [open, setOpen] = useState(false);
  const pane = useAgentPane();
  const openArtifact = useOpenArtifact();
  const { say } = useCardActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const changes = useChanges(item.agentId, { patches: false, enabled: open }).data;
  const code = vscodeUrl(changes?.checkoutPath);
  const stats = changes?.state === 'ready' ? changes.stats : undefined;
  const status = pillOf(item.status);
  const where = [c.repo, item.branch].filter(Boolean).join(' › ');
  const note = item.status === 'blocked' && item.entry?.blocker ? `Blocked: ${item.entry.blocker}` : item.status === 'draft' ? (item.entry?.progress ?? item.entry?.focus) : undefined;
  const you = item.status === 'review' ? 'waiting on you' : item.status === 'approved' || item.status === 'merged' ? 'approved' : undefined;

  const approve = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await say(c.roundUpId, approveTurn(pr));
    } catch (err) {
      setError(`Couldn't approve it: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <li className={cn(card, 'overflow-hidden')}>
        <CollapsibleTrigger className={cn('flex w-full items-center gap-3 px-3.5 py-3 text-left', open ? 'bg-raise' : 'hover:bg-hov')}>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className={cn('inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium', status.className)}>{status.label}</span>
              <span className="text-fg truncate text-sm font-medium">{item.title}</span>
              {item.ref && <span className="text-mu2 shrink-0 font-mono text-xs">{item.ref}</span>}
            </span>
            <span className="text-mu flex min-w-0 items-center gap-1.5 text-xs">
              {item.harness && <HarnessMark harness={item.harness} className="size-4" />}
              {item.agentTitle && <span className="shrink-0">{item.agentTitle}</span>}
              {where && (
                <>
                  {item.agentTitle && <span aria-hidden="true">·</span>}
                  <span className="truncate font-mono text-[11px]">{where}</span>
                </>
              )}
              {stats && (
                <span className="shrink-0">
                  · <Totals additions={stats.additions} deletions={stats.deletions} className="text-[11px]" /> · {filesLabel(stats.files)}
                </span>
              )}
            </span>
          </span>
          <ChevronDownIcon aria-hidden="true" className={cn('text-mu2 size-4 shrink-0 transition-transform', open && 'rotate-180')} />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-ln flex flex-col gap-3 border-t px-3.5 py-3">
          {you && (
            <div className="flex flex-wrap gap-1.5">
              <span className="bg-chip text-fg2 inline-flex h-6 items-center gap-1.5 rounded-full pr-2.5 pl-1 text-xs">
                <span aria-hidden="true" className="bg-fg text-background flex size-4 items-center justify-center rounded-[5px] text-[9px] font-semibold">
                  Y
                </span>
                You <span className={you === 'approved' ? 'text-done' : 'text-wait'}>{you}</span>
              </span>
            </div>
          )}
          {note && <p className="text-mu text-xs">{note}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {item.status === 'review' && (
              <>
                <button type="button" disabled={busy} onClick={() => void approve()} className={quietButton} title="Tells Kelpie, which moves it on">
                  Approve
                </button>
                {item.agentId && pane?.agents.some((a) => a.id === item.agentId) && (
                  <button type="button" onClick={() => pane.openAgent(item.agentId!)} className={quietButton} title={`Opens ${item.agentTitle ?? 'the agent'}, to message it`}>
                    Request changes
                  </button>
                )}
              </>
            )}
            <span className="flex-1" />
            {item.agentId && stats && (
              <button type="button" onClick={() => openArtifact({ kind: 'changes', agentId: item.agentId! })} className="text-mu hover:text-fg text-xs">
                View changes
              </button>
            )}
            {code && (
              <a href={code} className="text-mu hover:text-fg inline-flex items-center gap-1 text-xs">
                <CodeXmlIcon className="size-3" />
                Open in VS Code
              </a>
            )}
            {item.url && (
              <a href={item.url} target="_blank" rel="noreferrer" className="text-mu hover:text-fg inline-flex items-center gap-1 text-xs">
                {linkLabel(item.url)}
                <ExternalLinkIcon className="size-3" />
              </a>
            )}
          </div>
          {error && <p className="text-fail text-xs">{error}</p>}
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}
