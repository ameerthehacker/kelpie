import { CheckIcon, MinusIcon, PlusIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useSaveSettings, useSettings } from '@/hooks/use-settings';
import { MAX_AGENTS, parseAgents, stepAgents } from '@/lib/settings';

/** How long "Saved" stays after the last change lands. */
const SAVED_FOR = 1800;

/**
 * Parallel agents: −, the number (typed, or stepped with the arrow keys), +. Each change is saved as
 * it is made, shown at once and put back if the daemon refuses it.
 */
function ParallelAgents({ value }: { value: number }) {
  const save = useSaveSettings();
  const labelId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState<string | undefined>();
  const [invalid, setInvalid] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const statusId = useId();
  useEffect(() => () => clearTimeout(timer.current), []);

  const set = (next: number) => {
    setDraft(undefined);
    setInvalid(undefined);
    if (next === value) return;
    setSaved(false);
    clearTimeout(timer.current);
    save.mutate(
      { maxAgents: next },
      {
        onSuccess: () => {
          setSaved(true);
          timer.current = setTimeout(() => setSaved(false), SAVED_FOR);
        },
      },
    );
  };
  const commit = () => {
    if (draft === undefined) return;
    const parsed = parseAgents(draft);
    if ('error' in parsed) setInvalid(parsed.error);
    else set(parsed.value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const step = { ArrowUp: 1, ArrowDown: -1 }[e.key] as 1 | -1 | undefined;
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
          {MAX_AGENTS.min}–{MAX_AGENTS.max} · default {MAX_AGENTS.default}
          {value !== MAX_AGENTS.default && (
            <>
              <span aria-hidden="true">·</span>
              <button type="button" onClick={() => set(MAX_AGENTS.default)} className="hover:text-fg rounded-sm underline-offset-2 hover:underline">
                Reset to {MAX_AGENTS.default}
              </button>
            </>
          )}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1.5 max-sm:items-start">
        <ButtonGroup aria-labelledby={labelId}>
          <Button variant="outline" size="icon" aria-label="Fewer agents" disabled={value <= MAX_AGENTS.min} onClick={() => set(stepAgents(value, -1))}>
            <MinusIcon />
          </Button>
          <Input
            role="spinbutton"
            inputMode="numeric"
            aria-labelledby={labelId}
            aria-describedby={`${hintId} ${statusId}`}
            aria-valuemin={MAX_AGENTS.min}
            aria-valuemax={MAX_AGENTS.max}
            aria-valuenow={value}
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
          <Button variant="outline" size="icon" aria-label="More agents" disabled={value >= MAX_AGENTS.max} onClick={() => set(stepAgents(value, 1))}>
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

/** Settings › Agents: how many of a round-up's agents may work at once. */
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
      {data && <ParallelAgents value={data.maxAgents} />}
    </section>
  );
}
