import { useMutation } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

/** How long an unlinked ticket can be put back before it is unlinked for good. */
const UNDO_MS = 6000;
/** Time enough for the round-up's update to arrive after an unlink. */
const SETTLE_MS = 3000;

const ticketUrl = (roundUpId: string, ref: string) => `/api/sessions/${roundUpId}/tickets/${encodeURIComponent(ref)}`;

/**
 * Tickets the person unlinked that may still be put back, by round-up: hidden at once, unlinked on
 * the daemon when their toast goes (or the page does). Module state, so leaving the round-up
 * doesn't lose one.
 */
const hidden = new Map<string, Set<string>>();
const commits = new Map<string, () => void>();
const listeners = new Set<() => void>();
let snapshot = new Map<string, ReadonlySet<string>>();

function changed() {
  snapshot = new Map(hidden);
  listeners.forEach((l) => l());
}

function hide(roundUpId: string, ref: string, on: boolean) {
  const refs = new Set(hidden.get(roundUpId));
  if (on) refs.add(ref);
  else refs.delete(ref);
  if (refs.size) hidden.set(roundUpId, refs);
  else hidden.delete(roundUpId);
  changed();
}

// A page closed within the undo window still unlinks what the person unlinked.
window.addEventListener('pagehide', () => {
  for (const [key] of commits) {
    const [roundUpId, ref] = JSON.parse(key) as [string, string];
    void fetch(ticketUrl(roundUpId, ref), { method: 'DELETE', keepalive: true, headers: { 'content-type': 'application/json' }, body: '{}' });
  }
  commits.clear();
});

const NONE: ReadonlySet<string> = new Set();

/** The refs of a round-up's tickets unlinked but still in their undo window, to leave out. */
export function useHiddenTickets(roundUpId: string | undefined): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (roundUpId && snapshot.get(roundUpId)) || NONE,
  );
}

/**
 * The person's edits to a round-up's tickets: naming one (an empty title clears their name) and
 * unlinking one, which a toast lets them undo for a few seconds. The round-up's event stream
 * brings each change back to every view.
 */
export function useTicketEdits(roundUpId: string) {
  const rename = useMutation({ mutationFn: ({ ref, title }: { ref: string; title: string }) => api('PATCH', ticketUrl(roundUpId, ref), { title }) });
  const unlink = (ref: string, label: string) => {
    const key = JSON.stringify([roundUpId, ref]);
    const commit = () => {
      if (!commits.delete(key)) return;
      api('DELETE', ticketUrl(roundUpId, ref)).then(
        // Gone from the round-up once its update arrives; linked again later, it shows again.
        () => setTimeout(() => hide(roundUpId, ref, false), SETTLE_MS),
        (err: Error) => {
          hide(roundUpId, ref, false);
          if (!/no such ticket/.test(err.message)) toast.error(`Could not unlink “${label}”: ${err.message}`);
        },
      );
    };
    commits.set(key, commit);
    hide(roundUpId, ref, true);
    toast(`Unlinked “${label}”`, {
      duration: UNDO_MS,
      action: {
        label: 'Undo',
        onClick: () => {
          commits.delete(key);
          hide(roundUpId, ref, false);
        },
      },
      onAutoClose: commit,
      onDismiss: commit,
    });
  };
  return { rename, unlink };
}
