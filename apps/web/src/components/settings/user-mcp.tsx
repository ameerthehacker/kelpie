import { formatDistanceToNow } from 'date-fns';
import { CheckIcon, ChevronRightIcon, PlugIcon, RefreshCwIcon, SearchIcon, TerminalIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useMcpServers, useRefreshMcpServers } from '@/hooks/use-mcp-servers';
import { useNow } from '@/hooks/use-now';
import { useSaveSettings } from '@/hooks/use-settings';
import { allowedSummary, dropGrant, mcpRows, repoLabel, SCOPE_LABEL, setGrant, STATUS_LABEL, type McpGrant, type McpRow, type McpStatus } from '@/lib/mcp-servers';
import type { SettingsPatch } from '@/lib/settings';
import { cn } from '@/lib/utils';

/** How long "Saved" stays after the last change lands. */
const SAVED_FOR = 1800;

const STATUS_TONE: Record<McpStatus, string> = {
  connected: 'text-done bg-done/12',
  failed: 'text-fail bg-fail/10',
  'needs-auth': 'text-wait bg-wait/12',
  pending: 'text-mu bg-chip',
  unchecked: 'text-mu bg-chip',
};

const chip = 'rounded-full px-2 py-px text-[11px] font-medium';

/** From this many servers on, the list gets a filter. */
const FILTER_FROM = 6;

/** Whether a row matches the filter: by its name, type, scope or status. */
function matches(row: McpRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const s = row.server;
  return [row.name, SCOPE_LABEL[s?.scope ?? row.grant!.scope], s?.type, s && STATUS_LABEL[s.status]].some((t) => t?.toLowerCase().includes(q));
}

/** Why a row isn't simply on or off, in words a screen reader hears with its checkbox. */
function rowNote(row: McpRow): string | undefined {
  if (row.state === 'blocked') return row.server?.blocked;
  if (row.state === 'changed') return 'It changed since you allowed it (what it runs, where it connects, or its settings), so agents don’t get it. Tick it to allow it as it is now.';
  if (row.state === 'missing') return 'Claude Code no longer has it here. Untick it to forget it.';
  return undefined;
}

function ServerRow({ row, onToggle }: { row: McpRow; onToggle: (on: boolean) => void }) {
  const id = useId();
  const s = row.server;
  const note = rowNote(row);
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Checkbox
        id={id}
        checked={row.state === 'allowed' || row.state === 'missing'}
        disabled={row.state === 'blocked'}
        onCheckedChange={(v) => onToggle(v === true)}
        className="mt-0.5"
        aria-describedby={`${id}-meta${s?.runs ? ` ${id}-runs` : ''}${s?.warnings ? ` ${id}-warnings` : ''}${note ? ` ${id}-note` : ''}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label htmlFor={id} className={cn('truncate text-[13px] font-medium', row.state === 'blocked' ? 'text-mu' : 'text-fg cursor-pointer')}>
          {row.name}
        </label>
        <span id={`${id}-meta`} className="flex flex-wrap items-center gap-1.5">
          {s ? (
            <>
              <span className={cn(chip, 'bg-chip text-fg2 font-mono')}>{s.type}</span>
              <span className={cn(chip, 'bg-chip text-fg2')} title={s.repo}>
                {SCOPE_LABEL[s.scope]}
                {s.repo && <span className="sr-only"> server of {s.repo}</span>}
              </span>
              <span className={cn(chip, STATUS_TONE[s.status])}>{STATUS_LABEL[s.status]}</span>
              {row.state === 'changed' && <span className={cn(chip, 'text-wait bg-wait/12')}>Changed since allowed</span>}
            </>
          ) : (
            <span className={cn(chip, 'text-mu bg-chip')}>
              {SCOPE_LABEL[row.grant!.scope]} · not found
            </span>
          )}
        </span>
        {(s?.runs || s?.warnings) && (
          // Closed, the details stay in the page (hidden), so the checkbox is still described by them.
          <Collapsible className="group/details flex flex-col gap-1">
            <CollapsibleTrigger className="text-mu hover:text-fg2 focus-visible:ring-ring/50 flex w-fit items-center gap-1 rounded-md text-xs outline-none focus-visible:ring-3">
              <ChevronRightIcon aria-hidden="true" className="size-3.5 transition-transform group-data-[state=open]/details:rotate-90" strokeWidth={2} />
              {s.runs ? 'What it runs' : 'Details'}
              {s.warnings && (
                <span className="text-wait flex items-center gap-1">
                  · <TriangleAlertIcon aria-hidden="true" className="size-3" strokeWidth={2} />
                  {s.warnings.length === 1 ? '1 warning' : `${s.warnings.length} warnings`}
                </span>
              )}
            </CollapsibleTrigger>
            <CollapsibleContent forceMount className="flex flex-col gap-1 data-[state=closed]:hidden">
              {s?.runs && (
                <div id={`${id}-runs`} className="flex flex-col gap-0.5">
                  <span className="text-mu text-xs">This repo’s server runs:</span>
                  {s.runs.map((line, i) => (
                    <code key={i} className={cn('bg-chip rounded-md px-2 py-1 font-mono text-[11px] break-all whitespace-pre-wrap', line.includes('${') ? 'text-wait' : 'text-fg2')}>
                      {line}
                    </code>
                  ))}
                </div>
              )}
              {s?.warnings && (
                <ul id={`${id}-warnings`} className="text-wait flex flex-col gap-0.5 text-xs">
                  {s.warnings.map((w, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <TriangleAlertIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" strokeWidth={2} />
                      {w}
                    </li>
                  ))}
                </ul>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}
        {note && (
          <p id={`${id}-note`} className={cn('flex items-start gap-1.5 text-xs', row.state === 'blocked' ? 'text-fail' : 'text-wait')}>
            <TriangleAlertIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" strokeWidth={2} />
            {note}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * Use my Claude Code MCP servers: off, agents get only Kelpie's own server. On, they also get the
 * servers ticked below, each exactly as it was when ticked (each tool call still asks the person,
 * unless they allow it for a round-up); the orchestrator never does. The list is per repo: a
 * repo's own servers, and the person's local ones for it, are allowed for that repo only.
 */
export function UserMcp({ value, allow }: { value: boolean; allow: McpGrant[] }) {
  const save = useSaveSettings();
  const [picked, setPicked] = useState<string | undefined>();
  const list = useMcpServers(value, picked);
  const refresh = useRefreshMcpServers();
  const now = useNow();
  const labelId = useId();
  const hintId = useId();
  const statusId = useId();
  const listId = useId();
  const repoId = useId();
  const [query, setQuery] = useState('');
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const checkedOnce = useRef(new Set<string>());
  useEffect(() => () => clearTimeout(timer.current), []);
  const send = (patch: SettingsPatch) => {
    setSaved(false);
    clearTimeout(timer.current);
    save.mutate(patch, {
      onSuccess: () => {
        setSaved(true);
        timer.current = setTimeout(() => setSaved(false), SAVED_FOR);
      },
    });
  };

  const data = list.data;
  const repo = data?.repo;
  // Never checked with Claude Code for this repo (connectors come from it): check once, on the person's behalf.
  const { mutate: check } = refresh;
  useEffect(() => {
    if (!value || !repo || data?.checkedAt || checkedOnce.current.has(repo)) return;
    checkedOnce.current.add(repo);
    check({ repo, shown: picked });
  }, [value, repo, picked, data?.checkedAt, check]);

  const rows = data ? mcpRows(data.servers, allow, data.repo) : [];
  const filterable = rows.length >= FILTER_FROM;
  const shown = filterable ? rows.filter((row) => matches(row, query)) : rows;
  const checking = refresh.isPending;
  const error = refresh.error ?? list.error;
  const checkedAt = data?.checkedAt;
  const status = save.isPending ? (
    <span className="text-mu2 flex items-center gap-1.5">
      <Spinner className="size-3" /> Saving…
    </span>
  ) : save.isError ? (
    <span className="text-fail">Couldn’t save: {save.error.message}</span>
  ) : saved ? (
    <span className="text-done flex items-center gap-1">
      <CheckIcon className="size-3.5" strokeWidth={2.4} /> Saved
    </span>
  ) : null;

  return (
    <div className="bg-surf border-ln flex flex-col gap-3 rounded-[20px] border px-5 py-4">
      <div className="flex items-start gap-6 max-sm:flex-col max-sm:gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span id={labelId} className="flex items-center gap-2 text-[15px] font-medium">
            <PlugIcon aria-hidden="true" className="text-mu2 size-4" strokeWidth={1.8} />
            Use my Claude Code MCP servers
          </span>
          <p id={hintId} className="text-mu text-[13px] leading-relaxed">
            Agents can use these servers; each tool call asks you first, unless you choose Allow for round-up. The orchestrator never uses them.
          </p>
          {value && data && <p className="text-mu2 text-xs">{allowedSummary(rows)} · changes apply as agents next start</p>}
        </div>
        <div className="flex flex-col items-end gap-1.5 max-sm:items-start">
          <Switch checked={value} onCheckedChange={(on) => send({ useUserMcp: on })} aria-labelledby={labelId} aria-describedby={`${hintId} ${statusId}`} className="mt-1" />
          <p id={statusId} aria-live="polite" className="h-4 text-xs">
            {status}
          </p>
        </div>
      </div>

      {value && (
        <div className="border-ln flex flex-col gap-2 border-t pt-3">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <span id={listId} className="text-fg2 text-[13px] font-medium">
              Servers agents may use
            </span>
            <span className="flex items-center gap-2">
              <span className="text-mu2 text-xs" aria-live="polite">
                {checking ? 'Checking with Claude Code…' : checkedAt ? `Checked ${formatDistanceToNow(Math.min(new Date(checkedAt).getTime(), now), { addSuffix: true })}` : 'Not checked yet'}
              </span>
              <Button variant="ghost" size="sm" disabled={checking || !repo} onClick={() => repo && check({ repo, shown: picked })}>
                {checking ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
                Refresh
              </Button>
            </span>
          </div>
          {data && data.repos.length > 1 && (
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={repoId} className="text-mu text-xs">
                For round-ups in
              </label>
              <Select value={data.repo} onValueChange={setPicked}>
                <SelectTrigger id={repoId} size="sm" className="h-7 max-w-full text-xs" title={data.repo}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {data.repos.map((r) => (
                    <SelectItem key={r} value={r} title={r}>
                      {repoLabel(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {data && data.repos.length <= 1 && (
            <p className="text-mu text-xs">
              For round-ups in <span className="font-mono">{data.repo}</span>
            </p>
          )}
          {error && <p className="text-fail text-[13px]">Couldn’t list your servers: {error.message}</p>}
          {data?.error && (
            <p className="text-wait flex items-start gap-1.5 text-xs">
              <TriangleAlertIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" strokeWidth={2} />
              Couldn’t check them with Claude Code ({data.error}): claude.ai connectors may be missing.
            </p>
          )}
          {list.isPending ? (
            <div role="status" className="flex flex-col gap-2 py-2">
              <span className="sr-only">Looking for your servers…</span>
              <Skeleton className="h-10 w-full rounded-xl" />
              <Skeleton className="h-10 w-full rounded-xl" />
            </div>
          ) : rows.length ? (
            <>
              {filterable && (
                <div className="flex items-center gap-3">
                  <InputGroup className="h-8 flex-1">
                    <InputGroupAddon>
                      <SearchIcon aria-hidden="true" />
                    </InputGroupAddon>
                    <InputGroupInput
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Filter by name, type or scope"
                      aria-label="Filter servers"
                      aria-controls={`${listId}-list`}
                      className="text-[13px]"
                    />
                  </InputGroup>
                  <span className="text-mu2 shrink-0 text-xs tabular-nums" aria-live="polite">
                    {query.trim() ? `${shown.length} of ${rows.length}` : `${rows.length} servers`}
                  </span>
                </div>
              )}
              {/* Many servers scroll inside the card, so the page doesn't run on for screens. */}
              <ScrollArea className="-mx-2" viewportClassName="max-h-[min(28rem,60dvh)] px-2">
                <ul id={`${listId}-list`} aria-labelledby={listId} className="divide-ln flex flex-col divide-y">
                  {shown.map((row) => (
                    <ServerRow
                      key={row.key}
                      row={row}
                      onToggle={(on) => send({ mcpAllow: row.server ? setGrant(allow, row.server, on) : dropGrant(allow, row.key) })}
                    />
                  ))}
                </ul>
                {!shown.length && <p className="text-mu py-2 text-[13px]">No server matches “{query.trim()}”.</p>}
              </ScrollArea>
            </>
          ) : (
            data && (
              <p className="text-mu py-2 text-[13px]">
                Claude Code has no MCP servers set up here. Add some with <code className="font-mono text-xs">claude mcp add</code>, then Refresh.
              </p>
            )
          )}
          <p className="text-wait flex items-start gap-1.5 text-xs leading-relaxed">
            <TerminalIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" strokeWidth={2} />
            A stdio server runs a command on this Mac, as you, each time an agent starts (from an empty folder, not the agent’s). Allow only ones you trust, and prefer packages pinned to a version.
          </p>
          <p className="text-mu2 text-xs leading-relaxed">
            Each one is allowed on its own, claude.ai connectors included, and only as it is now: if what it runs or its settings change, it needs allowing again. A repo’s own
            servers (Project) are allowed for that repo only, and Kelpie doesn’t start them just to check them.
          </p>
        </div>
      )}
    </div>
  );
}
