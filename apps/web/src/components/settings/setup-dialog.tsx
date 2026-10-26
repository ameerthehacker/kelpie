import { useEffect, useState } from 'react';
import { KelpieLogo } from '@/components/shell/brand';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useHarnessStatus } from '@/hooks/use-harness-status';
import { isReady, needsSetup } from '@/lib/harness-setup';
import { CheckAgain, SetupSteps } from './harness-section';

/**
 * First run: shown while Claude Code is missing or signed out (the live status, nothing stored),
 * walking the person through install → sign in → Check again. Once all is green it says so and lets
 * them carry on; past setup but not green (sign-in unknown, a failed check) it says that instead. "Not now" holds until the page reloads; a working setup never sees it.
 */
export function HarnessSetupDialog({ hidden }: { hidden?: boolean }) {
  const { data } = useHarnessStatus();
  const claude = data?.find((h) => h.harness === 'claude-code');
  const needed = needsSetup(claude);
  const ready = isReady(claude);
  // Stays open once shown, so turning green reads as "all set" rather than vanishing.
  const [shown, setShown] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (needed) setShown(true);
  }, [needed]);

  if (!claude) return null;
  return (
    <Dialog open={shown && !dismissed && !hidden} onOpenChange={(open) => !open && setDismissed(true)}>
      <DialogContent className="max-h-[90dvh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <KelpieLogo className="mb-1 size-10" />
          <DialogTitle className="font-heading text-xl">{needed ? 'Set up Claude Code' : ready ? 'You’re all set' : 'Almost there'}</DialogTitle>
          <DialogDescription>
            {needed
              ? 'Kelpie runs your agents on your own Claude Code. Install it and sign in from a terminal, then check again.'
              : ready
                ? 'Claude Code is installed and signed in. Kelpie is ready to run your agents.'
                : claude.error
                  ? `Claude Code is installed, but checking it failed: ${claude.error}`
                  : 'Claude Code is installed, but Kelpie couldn’t tell whether it is signed in.'}
          </DialogDescription>
        </DialogHeader>
        <SetupSteps status={claude} />
        <DialogFooter>
          {needed ? (
            <>
              <Button variant="ghost" onClick={() => setDismissed(true)}>
                Not now
              </Button>
              <CheckAgain variant="default" />
            </>
          ) : (
            <>
              {!ready && <CheckAgain />}
              <Button onClick={() => setDismissed(true)}>Continue</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
