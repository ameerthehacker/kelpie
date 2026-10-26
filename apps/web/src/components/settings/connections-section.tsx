import { formatDistanceToNow } from 'date-fns';
import { ExternalLinkIcon, KeyRoundIcon, PlugIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { useState, type ComponentType, type FormEvent, type ReactNode } from 'react';
import { GitHubLogo } from '@/components/github-logo';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useConnection, useConnections, type ConnectionStatus } from '@/hooks/use-connections';
import { useNow } from '@/hooks/use-now';
import { cn } from '@/lib/utils';

/** What the page knows about each connector beyond its status; one the daemon adds later shows with a plug. */
const CONNECTORS: Record<string, { icon: ComponentType<{ className?: string; label?: string }>; blurb: string }> = {
  github: {
    icon: GitHubLogo,
    blurb: 'Pull requests, issues, reviews and repo contents. Agents get it as GH_TOKEN, so gh and git push work inside them.',
  },
};

// Classic tokens with the scopes agents need for PRs, issues, reviews and contents; fine-grained ones are set up by hand.
const CLASSIC_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:org,workflow&description=Kelpie';
const FINE_GRAINED_URL = 'https://github.com/settings/personal-access-tokens/new';

const Code = ({ children }: { children: ReactNode }) => <code className="bg-chip text-fg2 rounded px-1 py-px font-mono text-[12px]">{children}</code>;

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-fg inline-flex items-center gap-0.5 underline-offset-2 hover:underline">
      {children}
      <ExternalLinkIcon className="size-3" strokeWidth={2} />
    </a>
  );
}

/** Settings → Connections: the services Kelpie and its agents act on the person's behalf with. */
export function ConnectionsSection() {
  const { data, error } = useConnections();
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-fg text-[15px] font-medium">Connections</h2>
        <p className="text-mu text-sm">Services Kelpie can use for you. Every agent it starts gets what they're connected with.</p>
      </div>
      {error && <p className="text-fail text-sm">Couldn't load connections: {error.message}</p>}
      {!data && !error && <Skeleton className="h-28 rounded-[20px]" />}
      {data && (
        <ul className="flex flex-col gap-3">
          {data.map((c) => (
            <li key={c.id}>
              <ConnectorCard status={c} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConnectorCard({ status }: { status: ConnectionStatus }) {
  const { connect, check, disconnect } = useConnection(status.id);
  const now = useNow();
  const [pasting, setPasting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const known = CONNECTORS[status.id];
  const Icon = known?.icon ?? PlugIcon;
  const viaToken = status.method === 'token';
  // A refused token (or none) needs a new one; otherwise the form waits behind "Use a token instead".
  const showForm = !status.connected || pasting;
  const busy = connect.isPending || check.isPending || disconnect.isPending;
  const actionError = check.error ?? disconnect.error;

  return (
    <div className="bg-surf border-ln flex flex-col gap-3 rounded-[20px] border px-4 py-3.5">
      <div className="flex items-start gap-3">
        <span className="bg-chip text-fg grid size-9 shrink-0 place-items-center rounded-xl">
          <Icon className="size-[18px]" label="" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-fg text-[15px] font-medium">{status.name}</span>
            <StatusChip status={status} />
          </div>
          {known && <p className="text-mu text-[13px]">{known.blurb}</p>}
        </div>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => check.mutate()} title={`Checked ${formatDistanceToNow(Math.min(status.checkedAt, now), { addSuffix: true })}`}>
          {check.isPending ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
          Check again
        </Button>
      </div>

      {status.account && <Account status={status} />}
      {status.error && (
        <p className="text-fail flex items-start gap-1.5 text-[13px]">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
          {status.error}
        </p>
      )}
      {actionError && <p className="text-fail text-[13px]">{actionError.message}</p>}

      {status.id === 'github' && <GitHubHelp status={status} />}

      {showForm ? (
        <TokenForm
          pending={connect.isPending}
          error={connect.error?.message}
          replacing={viaToken || status.connected}
          onSubmit={(token) => connect.mutate(token, { onSuccess: () => setPasting(false) })}
          {...(pasting
            ? {
                onCancel: () => {
                  setPasting(false);
                  connect.reset();
                },
              }
            : {})}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setPasting(true)}>
            <KeyRoundIcon />
            {viaToken ? 'Replace token' : 'Use a token instead'}
          </Button>
          {viaToken && (
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
          )}
        </div>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Forget your {status.name} token?</DialogTitle>
            <DialogDescription>
              Kelpie deletes its copy, and agents started from now on won't get it. The token itself stays valid on {status.name}: revoke it there if you no longer need it.
              {status.cli?.loggedIn && ` Kelpie then uses your ${status.cli.name} login instead.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                disconnect.mutate();
                setConfirming(false);
              }}
            >
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusChip({ status }: { status: ConnectionStatus }) {
  const [label, tone] = status.connected
    ? ['Connected', 'text-done bg-done/12']
    : status.method
      ? ['Not working', 'text-fail bg-fail/10']
      : ['Not connected', 'text-mu bg-chip'];
  return <span className={cn('rounded-full px-2 py-px text-[11px] font-medium', tone)}>{label}</span>;
}

/** Who it acts as, how it got in, and what it may do. */
function Account({ status }: { status: ConnectionStatus }) {
  const { account, scopes } = status;
  if (!account) return null;
  const via = status.method === 'gh' ? 'through the gh CLI' : status.method === 'token' ? 'with a personal access token' : undefined;
  const name = account.name ? `${account.name} · @${account.login}` : `@${account.login}`;
  return (
    <div className="bg-well flex flex-col gap-2 rounded-2xl px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        {account.avatarUrl ? (
          <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" className="bg-chip size-8 shrink-0 rounded-full" />
        ) : (
          <span className="bg-chip size-8 shrink-0 rounded-full" />
        )}
        <span className="flex min-w-0 flex-col">
          {account.url ? (
            <a href={account.url} target="_blank" rel="noreferrer" className="text-fg truncate text-sm font-medium hover:underline">
              {name}
            </a>
          ) : (
            <span className="text-fg truncate text-sm font-medium">{name}</span>
          )}
          {via && <span className="text-mu text-xs">Connected {via}</span>}
        </span>
      </div>
      {scopes && scopes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {scopes.map((s) => (
            <span key={s} className="bg-chip text-fg2 rounded-full px-2 py-px font-mono text-[11px]">
              {s}
            </span>
          ))}
        </div>
      )}
      {scopes === null && status.method === 'token' && <p className="text-mu text-xs">A fine-grained token: GitHub doesn't list what it may do.</p>}
      {status.id === 'github' && scopes && !scopes.includes('repo') && (
        <p className="text-wait text-xs">
          No <Code>repo</Code> scope: agents can't push or open pull requests on private repos.
        </p>
      )}
    </div>
  );
}

/** How to connect GitHub: gh first (nothing to paste), or a token. */
function GitHubHelp({ status }: { status: ConnectionStatus }) {
  const cli = status.cli;
  if (status.method === 'gh' && status.connected) {
    return (
      <p className="text-mu text-[13px]">
        gh manages this login: to switch accounts, run <Code>gh auth login</Code> (or <Code>gh auth logout</Code>), then check again.
      </p>
    );
  }
  if (status.connected || !cli) return null;
  return (
    <p className="text-mu text-[13px]">
      {cli.installed ? (
        <>
          The GitHub CLI is installed but not logged in. Run <Code>gh auth login</Code> in a terminal, then check again: Kelpie uses its login, with nothing to paste.
        </>
      ) : (
        <>
          The easiest way: install the <Ext href="https://cli.github.com">GitHub CLI</Ext> and run <Code>gh auth login</Code>, then check again. Kelpie uses its login, with
          nothing to paste.
        </>
      )}
    </p>
  );
}

function TokenForm({ pending, error, replacing, onSubmit, onCancel }: {
  pending: boolean;
  error: string | undefined;
  replacing: boolean;
  onSubmit: (token: string) => void;
  onCancel?: () => void;
}) {
  const [token, setToken] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (token.trim()) onSubmit(token.trim());
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <label htmlFor="github-token" className="text-fg2 text-[13px] font-medium">
        {replacing ? 'Paste a new personal access token' : 'Or paste a personal access token'}
      </label>
      <div className="flex gap-2">
        <Input
          id="github-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="ghp_… or github_pat_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-invalid={!!error}
          className="font-mono"
        />
        <Button type="submit" disabled={pending || !token.trim()}>
          {pending && <Spinner className="size-3.5" />}
          {pending ? 'Checking' : 'Connect'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {error && <p className="text-fail text-[13px]">{error}</p>}
      <p className="text-mu text-xs">
        <Ext href={CLASSIC_TOKEN_URL}>Create a classic token</Ext> with <Code>repo</Code>, <Code>read:org</Code> and <Code>workflow</Code>, or a{' '}
        <Ext href={FINE_GRAINED_URL}>fine-grained one</Ext> with read and write access to Contents, Pull requests and Issues. Kelpie checks it with GitHub, then keeps it in its
        database under ~/.kelpie; it never comes back to this page.
      </p>
    </form>
  );
}
