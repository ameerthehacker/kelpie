import { format } from 'date-fns';
import { ExternalLinkIcon, RefreshCwIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { CodeBlock, CodeBlockCopyButton } from '@/components/ai-elements/code-block';
import { HarnessMark } from '@/components/harness-mark';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useHarnessStatus } from '@/hooks/use-harness-status';
import { authLabel, binDir, CLAUDE_CODE_DOCS, installCommands, isReady, needsSetup, offPath, pathCommands, setupSteps, type Command, type HarnessStatus, type SetupStep } from '@/lib/harness-setup';
import { harnessOf } from '@/lib/harnesses';
import { cn } from '@/lib/utils';

/** A command to paste into a terminal, with a copy button. */
function CopyCommand({ command }: { command: string }) {
  return (
    <CodeBlock code={command} language="bash" className="bg-well rounded-xl border-0 pr-10 [&_pre]:py-2.5 [&_pre]:text-[13px]">
      <CodeBlockCopyButton aria-label={`Copy ${command}`} className="text-mu hover:text-fg absolute top-1/2 right-1.5 z-10 size-7 -translate-y-1/2" />
    </CodeBlock>
  );
}

/** "Check again": asks the daemon afresh, spinning while it does. */
export function CheckAgain({ className, variant = 'outline' }: { className?: string; variant?: 'outline' | 'default' }) {
  const { refetch, isFetching } = useHarnessStatus();
  return (
    <Button variant={variant} onClick={() => void refetch()} disabled={isFetching} className={className}>
      <RefreshCwIcon className={cn(isFetching && 'animate-spin')} />
      {isFetching ? 'Checking…' : 'Check again'}
    </Button>
  );
}

const MARK: Record<SetupStep['state'], string> = {
  done: 'bg-done text-white',
  todo: 'shadow-[inset_0_0_0_1.5px_var(--wait)] text-wait',
  unknown: 'shadow-[inset_0_0_0_1.5px_var(--bd)] text-mu',
  waiting: 'shadow-[inset_0_0_0_1.5px_var(--bd)] text-mu2',
};

function Commands({ commands }: { commands: Command[] }) {
  return (
    <>
      {commands.map((c) => (
        <div key={c.command} className="flex flex-col gap-1">
          <span className="text-mu2 text-xs">{c.label}</span>
          <CopyCommand command={c.command} />
        </div>
      ))}
    </>
  );
}

/** What to do next for one step: the commands to run, in the person's own terminal. */
function StepHelp({ step, status }: { step: SetupStep; status: HarnessStatus }) {
  if (step.id === 'install' && step.state === 'todo' && offPath(status)) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-mu text-[13px]">
          It is in <code className="font-mono">{binDir(status)}</code>, which isn’t on the PATH Kelpie was started with, so Kelpie can’t start it.{' '}
          {status.platform === 'win32' ? 'Add that folder to your Path in Settings › Environment Variables.' : 'Add that folder to your PATH:'}
        </p>
        <Commands commands={pathCommands(status)} />
        <p className="text-mu2 text-xs">Then stop Kelpie and start it again from a new terminal. Work that was under way picks up once it can.</p>
      </div>
    );
  }
  if (step.id === 'install' && step.state === 'todo') {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-mu text-[13px]">Run Claude Code’s official installer in a terminal:</p>
        <Commands commands={installCommands(status.platform)} />
        <a href={CLAUDE_CODE_DOCS} target="_blank" rel="noreferrer" className="text-mu hover:text-fg flex w-fit items-center gap-1 text-[13px] underline-offset-4 hover:underline">
          Other ways to install, and system requirements <ExternalLinkIcon className="size-3" />
        </a>
      </div>
    );
  }
  if (step.id === 'login' && step.state === 'todo') {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-mu text-[13px]">Start Claude Code in a terminal and follow its sign-in, then come back here:</p>
        <CopyCommand command="claude" />
        <p className="text-mu2 text-xs">A Claude subscription or an Anthropic Console account both work.</p>
      </div>
    );
  }
  if (step.id === 'login' && step.state === 'unknown') {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-mu text-[13px]">
          This version of Claude Code can’t say whether it is signed in. If agents fail to start, run <code className="font-mono">claude</code> to sign in, or update it:
        </p>
        <CopyCommand command="claude update" />
      </div>
    );
  }
  return null;
}

/** Install, then sign in: each step's mark, and help for the ones still to do. */
export function SetupSteps({ status }: { status: HarnessStatus }) {
  return (
    <ol className="flex flex-col gap-4">
      {setupSteps(status).map((step, i) => (
        <li key={step.id} className="flex gap-3">
          <span aria-hidden="true" className={cn('mt-px inline-flex size-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold', MARK[step.state])}>
            {step.state === 'done' ? '✓' : step.state === 'unknown' ? '?' : i + 1}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <span className={cn('text-[15px]', step.state === 'waiting' ? 'text-mu2' : 'text-fg font-medium')}>{step.title}</span>
              <span className="sr-only">{step.state === 'done' ? 'done' : step.state === 'todo' ? 'to do' : step.state === 'unknown' ? 'not known' : 'after installing'}</span>
              {step.detail && <span className="text-mu text-[13px]">{step.detail}</span>}
            </div>
            <StepHelp step={step} status={status} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function Fact({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-mu2">{label}</dt>
      <dd className={cn('text-fg2 min-w-0 break-all', mono && 'font-mono text-xs leading-5')}>{children}</dd>
    </>
  );
}

const yesNo = (v: boolean | null) => (v === null ? 'Couldn’t tell' : v ? 'Yes' : 'No');

/** One harness: what was found, and what to do about anything missing. */
function HarnessCard({ status }: { status: HarnessStatus }) {
  const ready = isReady(status);
  return (
    <div className="bg-surf border-ln flex flex-col gap-4 rounded-[20px] border px-5 py-4">
      <div className="flex items-center gap-2.5">
        <HarnessMark harness={status.harness} size="lg" />
        <span className="flex-1 text-[15px] font-medium">{harnessOf(status.harness).name}</span>
        <span className={cn('flex items-center gap-1.5 text-[13px]', ready ? 'text-done' : 'text-wait')}>
          <span aria-hidden="true" className={cn('size-[7px] rounded-full', ready ? 'bg-done' : 'bg-wait')} />
          {ready ? 'Ready' : needsSetup(status) ? 'Needs setup' : status.error ? 'Not working' : 'Sign-in unknown'}
        </span>
      </div>
      <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
        <Fact label="Installed">{yesNo(status.installed)}</Fact>
        <Fact label="Version">{status.version ?? '—'}</Fact>
        <Fact label="Path" mono>
          {status.path ?? '—'}
          {offPath(status) && <span className="text-wait font-sans"> · not on PATH</span>}
        </Fact>
        <Fact label="Signed in">
          {yesNo(status.installed ? status.loggedIn : false)}
          {status.loggedIn && status.authMethod ? ` · ${authLabel(status.authMethod)}` : ''}
        </Fact>
      </dl>
      {status.error && <p className="text-fail font-mono text-xs break-words">{status.error}</p>}
      {!ready && (
        <div className="border-ln border-t pt-4">
          <SetupSteps status={status} />
        </div>
      )}
    </div>
  );
}

/** Settings › Harness: the CLIs Kelpie runs agents on, checked live. */
export function HarnessSection() {
  const { data, error, dataUpdatedAt, isPending } = useHarnessStatus();
  return (
    <section id="harness" aria-labelledby="harness-title" className="flex scroll-mt-4 flex-col gap-3">
      <div className="flex items-end gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <h2 id="harness-title" className="font-heading text-xl font-semibold tracking-[-0.02em]">
            Harness
          </h2>
          <p className="text-mu text-[13px]">Kelpie runs every agent on your own Claude Code, with your own subscription. It never installs or signs in for you.</p>
        </div>
        <CheckAgain />
      </div>
      {isPending && <Skeleton className="h-40 w-full rounded-[20px]" />}
      {error && <p className="text-fail text-sm">Couldn’t ask the daemon: {error.message}</p>}
      {data?.map((s) => <HarnessCard key={s.harness} status={s} />)}
      {dataUpdatedAt > 0 && <p className="text-mu2 text-xs">Checked at {format(dataUpdatedAt, 'p')}</p>}
    </section>
  );
}
