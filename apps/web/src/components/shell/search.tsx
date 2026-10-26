import { CommandIcon, MonitorIcon, MoonIcon, PlusIcon, SearchIcon, SettingsIcon, SunIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { StatusDot } from '@/components/agents/agent-bits';
import { useAgentPane } from '@/components/agents/pane-state';
import { HarnessMark } from '@/components/harness-mark';
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Kbd } from '@/components/ui/kbd';
import { useRoundUpStatus } from '@/hooks/use-round-up-status';
import { ROUND_UP_STATUS_LABEL, roundUpPath, titleOf, type RoundUp } from '@/lib/round-ups';
import { setTheme } from '@/lib/theme';

// userAgentData isn't in TypeScript's DOM lib yet; platform is the fallback where it's missing.
const platform = (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ?? navigator.platform;
const isMac = /mac|iphone|ipad/i.test(platform);

/** The header's "Search ⌘K": jump to a round-up or one of this round-up's agents, or start a new one. */
export function Search({ roundUps }: { roundUps: RoundUp[] | undefined }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const pane = useAgentPane();
  const statusOf = useRoundUpStatus();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={isMac ? 'Search (⌘K)' : 'Search (Ctrl+K)'}
        aria-keyshortcuts="Meta+K Control+K"
        className="bg-chip text-mu hover:bg-raise flex h-[34px] shrink-0 items-center gap-2 rounded-full pr-2.5 pl-3 text-[13px]"
      >
        <SearchIcon className="size-3.5" strokeWidth={2} />
        <span className="max-sm:hidden">Search</span>
        {/* ⌘ as an icon: neither Geist face has the glyph, and the fallback font draws it small and off the baseline. */}
        <Kbd className="border-ln2 bg-surf text-mu2 dark:bg-white/5 ml-1 gap-0.5 rounded-xs border px-1.5 text-[11px] leading-none max-sm:hidden [&_svg:not([class*='size-'])]:size-2.5">
          {isMac ? (
            <>
              <CommandIcon strokeWidth={2.25} />K
            </>
          ) : (
            'Ctrl K'
          )}
        </Kbd>
      </button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Search" description="Jump to a round-up or an agent" className="top-[18vh] sm:max-w-2xl">
        {/* This CommandDialog leaves the cmdk root to its children. */}
        <Command className="[&_[data-slot=command-input-wrapper]]:p-2 [&_[data-slot=command-input-wrapper]]:pb-1 [&_[data-slot=input-group]]:h-11!">
          <CommandInput placeholder="Jump to a round-up or an agent…" className="text-[15px]" />
          <CommandList className="max-h-[min(60vh,30rem)] p-1">
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {!!pane?.agents.length && (
              <CommandGroup heading="Agents in this round-up">
                {pane.agents.map((a) => (
                  <CommandItem key={a.id} value={`agent ${a.title} ${a.id}`} onSelect={run(() => pane.openAgent(a.id))}>
                    <HarnessMark harness={a.harness} />
                    <span className="min-w-0 flex-1 truncate">{a.title}</span>
                    <StatusDot status={a.status} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {!!roundUps?.length && (
              <CommandGroup heading="Round-ups">
                {roundUps.map((r) => {
                  const status = statusOf(r);
                  return (
                    <CommandItem key={r.id} value={`round-up ${titleOf(r)} ${r.id}`} onSelect={run(() => navigate(roundUpPath(r.id)))}>
                      <span className="min-w-0 flex-1 truncate">{titleOf(r)}</span>
                      {status && <StatusDot status={status} label={ROUND_UP_STATUS_LABEL[status]} />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            <CommandGroup heading="Actions">
              <CommandItem value="new round-up" onSelect={run(() => navigate('/'))}>
                <PlusIcon /> New round-up
              </CommandItem>
              <CommandItem value="settings harness claude code connections" onSelect={run(() => navigate('/settings'))}>
                <SettingsIcon /> Settings
              </CommandItem>
              <CommandItem value="theme light" onSelect={run(() => setTheme('light'))}>
                <SunIcon /> Light theme
              </CommandItem>
              <CommandItem value="theme dark" onSelect={run(() => setTheme('dark'))}>
                <MoonIcon /> Dark theme
              </CommandItem>
              <CommandItem value="theme system" onSelect={run(() => setTheme('system'))}>
                <MonitorIcon /> System theme
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
