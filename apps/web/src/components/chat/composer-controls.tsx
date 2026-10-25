import { CheckIcon, ChevronDownIcon, ChevronsRightIcon, ClipboardListIcon, FilePenLineIcon, GitBranchIcon, LockIcon } from 'lucide-react';
import { useState, type ComponentType } from 'react';
import type { Mode } from '@kelpie/protocol';
import { HarnessMark } from '@/components/harness-mark';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { Branch } from '@/hooks/use-branches';
import { harnessOf, modelLabel } from '@/lib/harnesses';
import { MODE_INFO } from '@/lib/modes';
import { cn } from '@/lib/utils';

/**
 * The composer's controls are chips whose labels give way as the composer narrows (it is a
 * `@container`): first the harness name, then the mode's and branch's labels, leaving icons.
 * Settings that only matter now and then live inside a chip's menu, not as chips of their own.
 */
const chip =
  'bg-chip text-fg2 hover:bg-raise data-[state=open]:bg-raise flex h-8 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-acc/40 disabled:cursor-default disabled:hover:bg-chip';
const caret = <ChevronDownIcon aria-hidden="true" className="text-mu2 size-[11px] shrink-0" strokeWidth={2.4} />;
const menu = 'bg-surf text-fg w-auto min-w-56 rounded-xl p-1.5';
const heading = 'text-mu2 px-2 pt-1.5 pb-1 text-[11px] font-medium tracking-wide uppercase';

/** The Claude Code CLI's model aliases; '' leaves the choice to the harness. */
const MODELS = ['', 'opus', 'sonnet', 'haiku'];

/** Which coding agent runs the round-up, and on what model. More per-harness settings go in this menu. */
export function HarnessMenu({ harness, model, onModel }: { harness: string; model: string; onModel: (m: string) => void }) {
  const models = model && !MODELS.includes(model) ? [...MODELS, model] : MODELS;
  const name = harnessOf(harness).name;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(chip, 'pl-[7px]')} aria-label={`${name}, ${model ? modelLabel(model) : 'default model'}`}>
        <HarnessMark harness={harness} />
        <span className="truncate">
          <span className="hidden @xl:inline">{name} · </span>
          {model ? modelLabel(model) : 'Default'}
        </span>
        {caret}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className={menu}>
        <DropdownMenuLabel className={heading}>Harness</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={harness}>
          <DropdownMenuRadioItem value={harness} className="gap-2">
            <HarnessMark harness={harness} />
            {name}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className={heading}>Model</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={model} onValueChange={onModel}>
          {models.map((m) => (
            <DropdownMenuRadioItem key={m} value={m}>
              {m ? modelLabel(m) : 'Default model'}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const MODE_ICON: Record<Mode, { Icon: ComponentType<{ className?: string; strokeWidth?: number }>; tint: string }> = {
  auto: { Icon: ChevronsRightIcon, tint: 'text-acc' },
  acceptEdits: { Icon: FilePenLineIcon, tint: 'text-wait' },
  plan: { Icon: ClipboardListIcon, tint: 'text-vio' },
};

export function ModeIcon({ mode, className }: { mode: Mode; className?: string }) {
  const { Icon, tint } = MODE_ICON[mode];
  return <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', tint, className)} strokeWidth={2.2} />;
}

/** How freely the round-up's agents work, among the modes its harness has. Shift+Tab in the box cycles. */
export function ModeMenu({ mode, modes, onMode }: { mode: Mode; modes: readonly Mode[]; onMode: (m: Mode) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={chip} aria-label={`Mode: ${MODE_INFO[mode].label}`} title="Mode (Shift+Tab to cycle)">
        <ModeIcon mode={mode} />
        <span className="hidden truncate @md:inline">{MODE_INFO[mode].label}</span>
        {caret}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className={cn(menu, 'w-80')}>
        <DropdownMenuLabel className={cn(heading, 'flex justify-between')}>
          Mode <span className="font-normal tracking-normal normal-case">Shift+Tab</span>
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mode} onValueChange={(m) => onMode(m as Mode)}>
          {modes.map((m) => (
            <DropdownMenuRadioItem key={m} value={m} className="items-start gap-2.5 py-2">
              <ModeIcon mode={m} className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="text-fg text-[13px]">{MODE_INFO[m].label}</span>
                <span className="text-mu text-xs leading-snug">{MODE_INFO[m].detail}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Where the round-up's feature branch starts: a searchable list (repos can have hundreds of
 * branches), remote ones first. Once writers have started from it, it is fixed and only shown.
 */
export function BranchPicker({
  base,
  onBase,
  branches,
  locked,
  clearable,
}: {
  base: string;
  onBase: (b: string) => void;
  branches: Branch[];
  locked: boolean;
  /** "Ask me" can be picked again (a round-up not created yet); otherwise only while none is chosen. */
  clearable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const label = base || 'Base: ask me';
  if (locked) {
    return (
      <span className={cn(chip, 'hover:bg-chip cursor-default')} title={`Writers started from ${base}; the base is fixed now`}>
        <LockIcon aria-hidden="true" className="text-mu2 size-3 shrink-0" strokeWidth={2.2} />
        <span className="hidden max-w-40 truncate @md:inline">{base}</span>
      </span>
    );
  }
  const pick = (b: string) => {
    onBase(b);
    setOpen(false);
  };
  const group = (heading: string, list: Branch[]) =>
    list.length > 0 && (
      <CommandGroup heading={heading}>
        {list.map((b) => (
          <CommandItem key={b.name} value={b.name} onSelect={() => pick(b.name)} className="gap-2">
            <GitBranchIcon className="text-mu2 size-3.5" strokeWidth={2} />
            <span className="truncate">{b.name}</span>
            {b.name === base && <CheckIcon className="ml-auto size-3.5" strokeWidth={2.4} />}
          </CommandItem>
        ))}
      </CommandGroup>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={chip} aria-label={`Base branch: ${label}`} title="The branch this round-up starts from">
        <GitBranchIcon aria-hidden="true" className="text-mu2 size-3.5 shrink-0" strokeWidth={2} />
        <span className="hidden max-w-40 truncate @md:inline">{label}</span>
        {caret}
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className={cn(menu, 'w-72 p-0')}>
        <Command>
          <CommandInput placeholder="Find a branch…" />
          <CommandList className="max-h-72">
            <CommandEmpty>No branch matches.</CommandEmpty>
            {(clearable || !base) && (
              <CommandGroup>
                <CommandItem value="Ask me before the first writer" onSelect={() => pick('')} className="text-mu">
                  Ask me before the first writer
                  {!base && <CheckIcon className="ml-auto size-3.5" strokeWidth={2.4} />}
                </CommandItem>
              </CommandGroup>
            )}
            {group('Remote', branches.filter((b) => b.remote))}
            {group('Local', branches.filter((b) => !b.remote))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
