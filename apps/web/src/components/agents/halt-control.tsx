import { PlayIcon, SquareIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { useHaltActions } from '@/hooks/use-halt';
import { resumeLabel, type HaltState } from '@/lib/halt';

const agents = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;

/**
 * "Stop all" while anything of the round-up is working (asking first, in a small popover, when more
 * than one would stop), and "Resume all (N)" while the person has it stopped. Both can show at once:
 * the person may talk to a stopped round-up, or pick one agent up on its own.
 */
export function HaltControl({ roundUpId, state }: { roundUpId: string; state: HaltState }) {
  const { stopAll, resumeAll, pending, error } = useHaltActions(roundUpId);
  const [open, setOpen] = useState(false);
  const [withKelpie, setWithKelpie] = useState(true);
  const switchId = useId();
  const titleId = useId();
  const descId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  // Each time it asks, it starts from stopping everything.
  const openChange = (next: boolean) => {
    if (next) setWithKelpie(true);
    setOpen(next);
  };
  if (!state.canStop && !state.halted) return null;
  const stopButton = (
    <Button
      variant="ghost"
      size="xs"
      disabled={pending}
      onClick={state.confirm ? undefined : () => stopAll(true)}
      title={`Stop ${agents(state.stoppable)}${state.kelpieWorking ? " and Kelpie's own turn" : ''}; they keep their work, and Resume all picks them up again`}
      className="text-mu hover:text-fg"
    >
      <SquareIcon aria-hidden="true" className="fill-current" />
      Stop all
    </Button>
  );
  return (
    <span className="flex shrink-0 items-center gap-1">
      {error && (
        <span role="alert" className="text-fail max-w-40 truncate text-xs" title={error}>
          {error}
        </span>
      )}
      {state.halted && (
        <Button variant="outline" size="xs" disabled={pending} onClick={resumeAll} title="Pick up what you stopped where it left off, as the agent limit allows">
          <PlayIcon aria-hidden="true" className="text-run fill-current" />
          {resumeLabel(state.resumable)}
        </Button>
      )}
      {state.canStop &&
        (state.confirm ? (
          <Popover open={open} onOpenChange={openChange}>
            <PopoverTrigger asChild>{stopButton}</PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-64"
              aria-labelledby={titleId}
              aria-describedby={descId}
              // The safe choice has focus: Enter right after opening doesn't stop everything.
              onOpenAutoFocus={(e) => {
                e.preventDefault();
                cancel.current?.focus();
              }}
            >
              <PopoverHeader>
                <PopoverTitle id={titleId}>Stop {agents(state.stoppable)}?</PopoverTitle>
                <PopoverDescription id={descId}>They keep their work. Nothing starts again until you resume.</PopoverDescription>
              </PopoverHeader>
              {state.kelpieWorking && (
                <label htmlFor={switchId} className="text-mu flex items-center justify-between gap-2 text-xs">
                  Stop Kelpie’s own turn too
                  <Switch id={switchId} checked={withKelpie} onCheckedChange={setWithKelpie} />
                </label>
              )}
              <div className="flex justify-end gap-1.5">
                <Button ref={cancel} variant="ghost" size="xs" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="xs"
                  disabled={pending}
                  onClick={() => {
                    stopAll(withKelpie);
                    setOpen(false);
                  }}
                >
                  <SquareIcon aria-hidden="true" className="fill-current" />
                  Stop all
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        ) : (
          stopButton
        ))}
    </span>
  );
}
