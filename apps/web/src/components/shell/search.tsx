import { MonitorIcon, MoonIcon, PlusIcon, SearchIcon, SettingsIcon, SunIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { StatusDot } from '@/components/agents/agent-bits';
import { useAgentPane } from '@/components/agents/pane-state';
import { HarnessMark } from '@/components/harness-mark';
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { roundUpPath, titleOf, type RoundUp } from '@/lib/round-ups';
import { setTheme } from '@/lib/theme';

/** The header's "Search ⌘K": jump to a round-up or one of this round-up's agents, or start a new one. */
export function Search({ roundUps }: { roundUps: RoundUp[] | undefined }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const pane = useAgentPane();

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
        aria-label="Search (⌘K)"
        className="bg-chip text-mu hover:bg-raise flex h-[34px] shrink-0 items-center gap-2 rounded-full pr-2 pl-3 text-[13px]"
      >
        <SearchIcon className="size-3.5" strokeWidth={2} />
        <span className="max-sm:hidden">Search</span>
        <span className="bg-raise text-mu rounded-md px-1.5 py-px font-mono text-[11px] max-sm:hidden">⌘K</span>
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
                {roundUps.map((r) => (
                  <CommandItem key={r.id} value={`round-up ${titleOf(r)} ${r.id}`} onSelect={run(() => navigate(roundUpPath(r.id)))}>
                    <span className="min-w-0 flex-1 truncate">{titleOf(r)}</span>
                    {r.busy && <StatusDot status="working" />}
                  </CommandItem>
                ))}
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
