import { CheckIcon, ChevronDownIcon, ChevronsRightIcon, ClipboardListIcon, FilePenLineIcon, GitBranchIcon, LockIcon } from 'lucide-react';
import { useId, useState, type ComponentType, type KeyboardEvent } from 'react';
import type { Effort, Mode } from '@kelpie/protocol';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
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
import { EFFORT_INFO, EFFORTS, effortOf, effortSuffix } from '@/lib/effort';
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

/**
 * Which coding agent runs the round-up, on what model, and how hard it thinks. Effort lives in this
 * menu rather than a chip of its own, and the chip names it only when it isn't the default.
 */
export function HarnessMenu({
  harness,
  model,
  onModel,
  effort,
  onEffort,
  effortNote,
}: {
  harness: string;
  model: string;
  onModel: (m: string) => void;
  /** '' for the harness's default. */
  effort: '' | Effort;
  onEffort: (e: '' | Effort) => void;
  /** A word on what the effort reaches (a round-up's agents start with it), beside its heading. */
  effortNote?: string | undefined;
}) {
  const models = model && !MODELS.includes(model) ? [...MODELS, model] : MODELS;
  const name = harnessOf(harness).name;
  const known = effortOf(effort);
  const suffix = effortSuffix(known);
  const modelName = model ? modelLabel(model) : 'Default model';
  const effortName = known ? `${EFFORT_INFO[known].label} effort` : 'Default effort';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(chip, 'pl-[7px]')} aria-label={`${name}, ${modelName.toLowerCase()}, ${effortName.toLowerCase()}`} title={`${modelName} · ${effortName}`}>
        <HarnessMark harness={harness} />
        <span className="truncate">
          <span className="hidden @xl:inline">{name} · </span>
          {model ? modelLabel(model) : 'Default'}
          {suffix && <span className="text-mu2">{suffix}</span>}
        </span>
        {caret}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className={cn(menu, 'w-[19rem]')}>
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
        <DropdownMenuSeparator />
        <EffortPicker effort={known} onEffort={onEffort} note={effortNote} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Effort as a segmented row of the menu's own radio items: Up and Down reach it like any item,
 * Left and Right step along it, and picking one keeps the menu open. A hint line says what the
 * hovered or focused level does, else the chosen one.
 */
function EffortPicker({ effort, onEffort, note }: { effort: '' | Effort; onEffort: (e: '' | Effort) => void; note: string | undefined }) {
  const [shown, setShown] = useState<'' | Effort | undefined>();
  const hint = EFFORT_INFO[shown ?? effortOf(effort)].hint;
  const labelId = useId();
  const hintId = useId();
  const step = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = e.key === 'ArrowRight' ? e.currentTarget.nextElementSibling : e.key === 'ArrowLeft' ? e.currentTarget.previousElementSibling : null;
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    (to as HTMLElement | null)?.focus();
  };
  return (
    <div className="px-1 pb-1">
      <DropdownMenuLabel className={cn(heading, 'flex justify-between px-1')}>
        <span id={labelId}>Effort</span> {note && <span className="font-normal tracking-normal normal-case">{note}</span>}
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={effort}
        onValueChange={(v) => onEffort(v as '' | Effort)}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        className="bg-chip flex gap-0.5 rounded-lg p-0.5"
        onPointerLeave={() => setShown(undefined)}
      >
        {EFFORTS.map((e) => (
          <DropdownMenuPrimitive.RadioItem
            key={e}
            value={e}
            aria-label={`${EFFORT_INFO[e].label} effort`}
            // Trying levels out shouldn't close the menu each time.
            onSelect={(ev) => ev.preventDefault()}
            onKeyDown={step}
            onFocus={() => setShown(e)}
            onBlur={() => setShown(undefined)}
            onPointerEnter={() => setShown(e)}
            className="text-mu data-[state=checked]:bg-surf dark:data-[state=checked]:bg-ln2 data-[state=checked]:text-fg data-[state=checked]:font-medium focus:ring-acc/40 hover:text-fg flex h-7 flex-1 cursor-default items-center justify-center rounded-md text-xs outline-none select-none focus:ring-2 data-[state=checked]:shadow-sm"
          >
            {EFFORT_INFO[e].short}
          </DropdownMenuPrimitive.RadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {/* Read with the row (aria-describedby), not announced on every hover. */}
      <p id={hintId} className="text-mu mt-1.5 min-h-8 px-1 text-xs leading-snug">
        {hint}
      </p>
    </div>
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
