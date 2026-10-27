import { CheckIcon, MinusIcon, MoonIcon, PlusIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useSaveSettings, useSettings } from '@/hooks/use-settings';
import { UserMcp } from '@/components/settings/user-mcp';
import { defaultAgents, MAX_AGENTS, PAGE_STEP, parseAgents, stepAgents, type SettingsPatch } from '@/lib/settings';

/** How long "Saved" stays after the last change lands. */
const SAVED_FOR = 1800;
/** A −/+ at its bound looks disabled but keeps focus (stepping past the bound does nothing). */
const bound = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-background dark:aria-disabled:hover:bg-input/30';

/**
 * Parallel agents: −, the number (typed, or stepped with the arrow, Page and Home/End keys), +. Each
 * change is saved as it is made, shown at once and put back if the daemon refuses it. Reset forgets
 * the saved value, so the default (maybe KELPIE_MAX_AGENTS) applies again.
 */
function ParallelAgents({ value, fallback }: { value: number; fallback: number }) {
  const save = useSaveSettings();
  const labelId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState<string | undefined>();
  const [invalid, setInvalid] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const statusId = useId();
  useEffect(() => () => clearTimeout(timer.current), []);

  const send = (patch: SettingsPatch) => {
    setSaved(false);
    clearTimeout(timer.current);
    save.mutate(
      patch,
      {
        onSuccess: () => {
          setSaved(true);
          timer.current = setTimeout(() => setSaved(false), SAVED_FOR);
        },
      },
    );
  };
  const set = (next: number) => {
    setDraft(undefined);
    setInvalid(undefined);
    if (next !== value) send({ maxAgents: next });
  };
  const commit = () => {
    if (draft === undefined) return;
    const parsed = parseAgents(draft);
    if ('error' in parsed) setInvalid(parsed.error);
    else set(parsed.value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const step = { ArrowUp: 1, ArrowDown: -1, PageUp: PAGE_STEP, PageDown: -PAGE_STEP }[e.key];
    const to = { Home: MAX_AGENTS.min, End: MAX_AGENTS.max }[e.key];
    if (step || to) {
      e.preventDefault();
      set(to ?? stepAgents(value, step!));
    } else if (e.key === 'Enter') commit();
    else if (e.key === 'Escape' && draft !== undefined) {
      e.preventDefault();
      setDraft(undefined);
      setInvalid(undefined);
    }
  };

  // What a screen reader hears as the value: what is typed, once it is a limit.
  const typed = draft === undefined ? undefined : parseAgents(draft);
  const shown = typed && 'value' in typed ? typed.value : value;
  const status = invalid ? (
    <span className="text-fail">{invalid}</span>
  ) : save.isPending ? (
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
    <div className="bg-surf border-ln flex items-start gap-6 rounded-[20px] border px-5 py-4 max-sm:flex-col max-sm:gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span id={labelId} className="text-[15px] font-medium">
          Parallel agents
        </span>
        <p id={hintId} className="text-mu text-[13px] leading-relaxed">
          How many agents can work at once in a round-up. More agents finish sooner but use your Claude usage faster.
        </p>
        <p className="text-mu2 flex items-center gap-1.5 text-xs">
          {MAX_AGENTS.min}–{MAX_AGENTS.max} · default {fallback}
          {value !== fallback && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => {
                  setDraft(undefined);
                  setInvalid(undefined);
                  send({ maxAgents: null });
                }}
                className="hover:text-fg rounded-sm underline-offset-2 hover:underline"
              >
                Reset to {fallback}
              </button>
            </>
          )}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1.5 max-sm:items-start">
        <ButtonGroup aria-labelledby={labelId}>
          {/* aria-disabled, not disabled: a button that goes disabled at the bound would drop the keyboard's focus. */}
          <Button variant="outline" size="icon" aria-label="Fewer agents" aria-disabled={value <= MAX_AGENTS.min} onClick={() => set(stepAgents(value, -1))} className={bound}>
            <MinusIcon />
          </Button>
          <Input
            role="spinbutton"
            inputMode="numeric"
            aria-labelledby={labelId}
            aria-describedby={`${hintId} ${statusId}`}
            aria-valuemin={MAX_AGENTS.min}
            aria-valuemax={MAX_AGENTS.max}
            aria-valuenow={shown}
            aria-invalid={!!invalid}
            value={draft ?? String(value)}
            onChange={(e) => {
              setDraft(e.target.value);
              setInvalid(undefined);
            }}
            onBlur={commit}
            onKeyDown={onKeyDown}
            onFocus={(e) => e.target.select()}
            className="h-8 w-12 flex-none rounded-none text-center font-mono text-sm tabular-nums"
          />
          <Button variant="outline" size="icon" aria-label="More agents" aria-disabled={value >= MAX_AGENTS.max} onClick={() => set(stepAgents(value, 1))} className={bound}>
            <PlusIcon />
          </Button>
        </ButtonGroup>
        <p id={statusId} aria-live="polite" className="h-4 text-xs">
          {status}
        </p>
      </div>
    </div>
  );
}

/**
 * Auto-resume after usage limits: on, work that stops at the limit picks up once it resets (the
 * person can sleep through it); off, it waits for them. Saved as it is flipped, like the stepper.
 */
function AutoResume({ value }: { value: boolean }) {
  const save = useSaveSettings();
  const labelId = useId();
  const hintId = useId();
  const statusId = useId();
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const set = (next: boolean) => {
    setSaved(false);
    clearTimeout(timer.current);
    save.mutate(
      { autoResume: next },
      {
        onSuccess: () => {
          setSaved(true);
          timer.current = setTimeout(() => setSaved(false), SAVED_FOR);
        },
      },
    );
  };
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
    <div className="bg-surf border-ln flex items-start gap-6 rounded-[20px] border px-5 py-4 max-sm:flex-col max-sm:gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span id={labelId} className="flex items-center gap-2 text-[15px] font-medium">
          <MoonIcon aria-hidden="true" className="text-mu2 size-4" strokeWidth={1.8} />
          Auto-resume after usage limits
        </span>
        <p id={hintId} className="text-mu text-[13px] leading-relaxed">
          When agents stop because you hit your Claude usage limit, Kelpie picks their work up again once the limit resets, so it can carry on overnight. Off: they wait for you.
        </p>
      </div>
      <div className="flex flex-col items-end gap-1.5 max-sm:items-start">
        <Switch checked={value} onCheckedChange={set} aria-labelledby={labelId} aria-describedby={`${hintId} ${statusId}`} className="mt-1" />
        <p id={statusId} aria-live="polite" className="h-4 text-xs">
          {status}
        </p>
      </div>
    </div>
  );
}

/** Settings › Agents: how many of a round-up's agents may work at once, whether work resumes after a usage limit, and which of the person's MCP servers they get. */
export function AgentsSection() {
  const { data, error } = useSettings();
  return (
    <section id="agents" aria-labelledby="agents-title" className="flex scroll-mt-4 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="agents-title" className="font-heading text-xl font-semibold tracking-[-0.02em]">
          Agents
        </h2>
        <p className="text-mu text-[13px]">How Kelpie runs the agents each round-up delegates to.</p>
      </div>
      {error && <p className="text-fail text-sm">Couldn’t load settings: {error.message}</p>}
      {!data && !error && <Skeleton className="h-[104px] w-full rounded-[20px]" />}
      {data && <ParallelAgents value={data.maxAgents} fallback={defaultAgents(data)} />}
      {data && <AutoResume value={data.autoResume ?? true} />}
      {data && <UserMcp value={data.useUserMcp ?? false} allow={data.mcpAllow ?? []} />}
    </section>
  );
}
