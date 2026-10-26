import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useMemo } from 'react';
import type { KelpieEvent } from '@kelpie/protocol';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { useSteady } from '@/hooks/use-steady';
import { orchestratorStatus } from '@/lib/activity';
import type { AgentSummary } from '@/lib/agents';

/** How long a status stays up before the next one replaces it. */
const MIN_SHOWN_MS = 1100;
/** How often, at most, a screen reader hears a new one: every step would be a stream of interruptions. */
const MIN_READ_MS = 5000;

/**
 * What the round-up is doing right now, under the chat while it is busy: one calm line from its
 * latest step ("Reading reports from …", "Thinking…", "Merging 2 branches"). Each status stays up
 * a moment and fades into the next, so quick steps don't flicker past.
 *
 * Mounted all along, busy or not: a live region only announces changes to one already in the
 * page, so screen readers get their own, quieter copy of the line here, and the animated one is hidden from them.
 */
export function WorkingStatus({ busy, events, agents }: { busy: boolean; events: readonly KelpieEvent[]; agents: readonly AgentSummary[] }) {
  const live = useMemo(() => (busy ? orchestratorStatus(events, agents) : ''), [busy, events, agents]);
  const text = useSteady(live, MIN_SHOWN_MS);
  const read = useSteady(live, MIN_READ_MS);
  const still = useReducedMotion();
  return (
    <>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {busy ? read : ''}
      </span>
      {busy && text && (
        <div aria-hidden="true" className="flex h-6 min-w-0 items-center gap-2.5 text-sm">
          <span className="bg-run size-[7px] shrink-0 rounded-full [--k-halo:var(--run)] motion-safe:animate-k-halo" />
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={text}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="flex min-w-0"
            >
              {still ? (
                <span className="text-mu max-w-full truncate">{text}</span>
              ) : (
                <Shimmer as="span" className="max-w-full truncate">
                  {text}
                </Shimmer>
              )}
            </motion.span>
          </AnimatePresence>
        </div>
      )}
    </>
  );
}
