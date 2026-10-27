import { formatDistanceToNow } from 'date-fns';
import { CheckIcon, PlugIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useMcpServers, useRefreshMcpServers } from '@/hooks/use-mcp-servers';
import { useSaveSettings } from '@/hooks/use-settings';
import { allowedSummary, mcpRows, SCOPE_LABEL, STATUS_LABEL, toggleAllow, type McpRow, type McpStatus } from '@/lib/mcp-servers';
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

function ServerRow({ row, onToggle }: { row: McpRow; onToggle: (on: boolean) => void }) {
  const id = useId();
  const s = row.server;
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Checkbox id={id} checked={row.allowed} disabled={!row.selectable} onCheckedChange={(v) => onToggle(v === true)} className="mt-0.5" aria-describedby={`${id}-meta`} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label htmlFor={id} className={cn('text-fg truncate text-[13px] font-medium', row.selectable ? 'cursor-pointer' : 'text-mu')}>
          {row.name}
        </label>
        <span id={`${id}-meta`} className="flex flex-wrap items-center gap-1.5">
          {s ? (
            <>
              <span className={cn(chip, 'bg-chip text-fg2 font-mono')}>{s.type}</span>
              <span className={cn(chip, 'bg-chip text-fg2')}>{SCOPE_LABEL[s.scope]}</span>
              <span className={cn(chip, STATUS_TONE[s.status])}>{STATUS_LABEL[s.status]}</span>
            </>
          ) : (
            <span className={cn(chip, 'text-mu bg-chip')}>Not found: Claude Code no longer has it</span>
          )}
        </span>
        {s?.blocked && (
          <p className="text-fail flex items-start gap-1.5 text-xs">
            <TriangleAlertIcon className="mt-px size-3.5 shrink-0" strokeWidth={2} />
            {s.blocked}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * Use my Claude Code MCP servers: off, agents get only Kelpie's own server. On, they also get the
 * servers ticked below (each tool call still asks the person); the orchestrator never does.
 */
export function UserMcp({ value, allow }: { value: boolean; allow: string[] }) {
  const save = useSaveSettings();
  const list = useMcpServers(value);
  const refresh = useRefreshMcpServers();
  const labelId = useId();
  const hintId = useId();
  const statusId = useId();
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
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

  const servers = list.data?.servers ?? [];
  const rows = mcpRows(servers, allow);
  const loading = list.isPending || refresh.isPending;
  const error = refresh.error ?? list.error;
  const checkError = list.data?.error;
  const checkedAt = list.data?.checkedAt;
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
            Agents can use these servers; each tool call asks you first. The orchestrator never uses them.
          </p>
          {value && list.data && <p className="text-mu2 text-xs">{allowedSummary(rows)} · changes apply as agents next start</p>}
        </div>
        <div className="flex flex-col items-end gap-1.5 max-sm:items-start">
          <Switch checked={value} onCheckedChange={(on) => send({ useUserMcp: on })} aria-labelledby={labelId} aria-describedby={`${hintId} ${statusId}`} className="mt-1" />
          <p id={statusId} aria-live="polite" className="h-4 text-xs">
            {status}
          </p>
        </div>
      </div>

      {value && (
        <div className="border-ln flex flex-col gap-1 border-t pt-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-fg2 text-[13px] font-medium">Servers agents may use</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => refresh.mutate()}
              title={checkedAt ? `Checked ${formatDistanceToNow(new Date(checkedAt), { addSuffix: true })}` : undefined}
            >
              {refresh.isPending ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
              Refresh
            </Button>
          </div>
          {error && <p className="text-fail text-[13px]">Couldn’t list your servers: {error.message}</p>}
          {checkError && (
            <p className="text-wait flex items-start gap-1.5 text-xs">
              <TriangleAlertIcon className="mt-px size-3.5 shrink-0" strokeWidth={2} />
              Couldn’t check them with Claude Code ({checkError}): claude.ai connectors may be missing.
            </p>
          )}
          {list.isPending ? (
            <div className="flex flex-col gap-2 py-2" aria-label="Looking for your servers">
              <Skeleton className="h-10 w-full rounded-xl" />
              <Skeleton className="h-10 w-full rounded-xl" />
            </div>
          ) : rows.length ? (
            <ul className="divide-ln flex flex-col divide-y">
              {rows.map((row) => (
                <ServerRow
                  key={row.name}
                  row={row}
                  onToggle={(on) =>
                    send({
                      mcpAllow: toggleAllow(
                        allow,
                        row.name,
                        on,
                        rows.map((r) => r.name),
                      ),
                    })
                  }
                />
              ))}
            </ul>
          ) : (
            list.data && <p className="text-mu py-2 text-[13px]">Claude Code has no MCP servers set up. Add some with <code className="font-mono text-xs">claude mcp add</code>, then Refresh.</p>
          )}
          <p className="text-mu2 text-xs leading-relaxed">
            Each one is picked on its own, claude.ai connectors included. Project servers come from this repo’s .mcp.json; Kelpie doesn’t start them just to check them.
          </p>
        </div>
      )}
    </div>
  );
}
