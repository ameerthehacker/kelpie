import { AnimatePresence, motion } from 'motion/react';
import { useMemo } from 'react';
import type { KelpieEvent } from '@kelpie/protocol';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { useSteady } from '@/hooks/use-steady';
import { orchestratorStatus } from '@/lib/activity';
import type { AgentSummary } from '@/lib/agents';

/** How long a status stays up before the next one replaces it. */
const MIN_SHOWN_MS = 1100;

/**
 * What the round-up is doing right now, under the chat while it is busy: one calm line from its
 * latest step ("Reading reports from …", "Thinking…", "Merging 2 branches"). Each status stays up
 * a moment and fades into the next, so quick steps don't flicker past.
 */
export function WorkingStatus({ events, agents }: { events: readonly KelpieEvent[]; agents: readonly AgentSummary[] }) {
  const live = useMemo(() => orchestratorStatus(events, agents), [events, agents]);
  const text = useSteady(live, MIN_SHOWN_MS);
  return (
    <div role="status" aria-live="polite" className="flex h-6 min-w-0 items-center gap-2.5 text-sm">
      <span aria-hidden="true" className="bg-run animate-k-pulse size-[7px] shrink-0 rounded-full" />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={text}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="flex min-w-0"
        >
          <Shimmer as="span" className="max-w-full truncate">
            {text}
          </Shimmer>
        </motion.span>
      </AnimatePresence>
    </div>
  );
}
