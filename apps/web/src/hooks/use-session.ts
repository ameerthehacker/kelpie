import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import type { KelpieEvent } from '@kelpie/protocol';
import { api, isGone } from '@/lib/api';
import { buildChat, latestTodos, type ChatItem } from '@/lib/chat';
import { logStream } from '@/lib/live-stream';
import { chatStatus, lastBusy, settlePending, type PendingMessage } from '@/lib/session-state';

export type { ChatStatus } from '@/lib/session-state';

const GONE = 'This round-up no longer exists. Your next message starts a new one.';

/** A sent message not yet echoed, tagged with the view it was sent from. */
interface Pending extends PendingMessage {
  /** A round-up id, or `draft:<n>` for a round-up not created yet. */
  view: string;
  /** The round-up created for it, when sent from a draft; it shows in both views across the move. */
  created?: string;
  /** Its POST has not answered yet. */
  sending: boolean;
}

const belongs = (m: Pending, view: string) => m.view === view || m.created === view;

/**
 * One round-up's conversation: its KEF log, live over SSE, plus send and
 * interrupt. `id` is undefined for a new round-up; the first send creates it
 * on the daemon and reports the id through `onCreated`.
 *
 * Sends outlive the view they started in (the user can switch round-ups
 * while one is in flight), so everything they touch on completion is
 * checked against the view on screen now.
 */
export function useSession(id: string | undefined, onCreated: (id: string) => void) {
  const [events, setEvents] = useState<KelpieEvent[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [goneView, setGoneView] = useState<string | undefined>();

  // Each visit to `/` is its own history entry, hence its own draft: a slow create from an earlier
  // one can't land in it. (Router state, not a counter: renders can be discarded, so they must not
  // mutate anything.)
  const { key } = useLocation();
  const view = id ?? `draft:${key}`;
  // Latest committed values, for sends that finish later.
  const viewRef = useRef(view);
  const goneRef = useRef(goneView);
  useLayoutEffect(() => {
    viewRef.current = view;
    goneRef.current = goneView;
  });
  const creating = useRef<{ view: string; promise: Promise<string> } | undefined>(undefined);
  const nextPendingId = useRef(0);

  const markGone = useCallback((gone: string) => {
    setGoneView(gone);
    setPending((p) => p.filter((m) => !belongs(m, gone)));
    if (viewRef.current === gone) setError(GONE);
  }, []);

  useEffect(() => {
    setEvents([]);
    setError(undefined);
    // Finished sends from other views are on the daemon now and come back through its log.
    setPending((p) => p.filter((m) => belongs(m, view) || m.sending));
    if (!id) return;

    return logStream(id, {
      onBatch: (batch) => {
        setEvents((prev) => prev.concat(batch));
        setPending((p) => {
          const mine = p.filter((m) => belongs(m, id));
          const settled = settlePending(mine, batch);
          return settled.length === mine.length ? p : [...p.filter((m) => !belongs(m, id)), ...settled];
        });
      },
      onGone: () => markGone(id),
      onStatus: setError,
    });
  }, [id, view, markGone]);

  const send = useCallback(
    async (text: string) => {
      const pendingId = nextPendingId.current++;
      const from = viewRef.current;
      let tag = from;
      setError(undefined);
      setPending((p) => [...p, { id: pendingId, text, view: from, sending: true }]);
      try {
        // A draft, or a round-up the daemon no longer has: create one first, once per view.
        let target = from.startsWith('draft:') || goneRef.current === from ? undefined : from;
        if (!target) {
          if (creating.current?.view !== from) {
            const promise = api<{ id: string }>('POST', '/api/sessions').then(({ id: created }) => {
              // Every message sent from this view goes with it, and stays visible while the route changes.
              setPending((p) => p.map((m) => (m.view === from ? { ...m, created } : m)));
              // Only follow it there if the user is still looking at where they sent from.
              if (viewRef.current === from) onCreated(created);
              return created;
            });
            creating.current = { view: from, promise };
            void promise.catch(() => {}).finally(() => creating.current?.promise === promise && (creating.current = undefined));
          }
          target = await creating.current!.promise;
          tag = target;
        }
        await api('POST', `/api/sessions/${target}/messages`, { text });
        // Off screen now: the daemon's log has it, and that view reloads from there.
        if (viewRef.current !== tag && viewRef.current !== from) setPending((p) => p.filter((m) => m.id !== pendingId));
        else setPending((p) => p.map((m) => (m.id === pendingId ? { ...m, sending: false } : m)));
      } catch (err) {
        setPending((p) => p.filter((m) => m.id !== pendingId));
        if (isGone(err)) markGone(tag);
        else if (viewRef.current === tag || viewRef.current === from) setError((err as Error).message);
        throw err;
      }
    },
    [markGone, onCreated],
  );

  const interrupt = useCallback(async () => {
    const current = viewRef.current;
    if (current.startsWith('draft:')) return;
    await api('POST', `/api/sessions/${current}/interrupt`).catch((err) =>
      isGone(err) ? markGone(current) : viewRef.current === current && setError(err.message),
    );
  }, [markGone]);

  const visible = useMemo(() => pending.filter((m) => belongs(m, view)), [pending, view]);
  const items = useMemo(
    () => [...buildChat(events), ...visible.map(({ id: pid, text }): ChatItem => ({ role: 'user', id: `pending-${pid}`, text }))],
    [events, visible],
  );
  const todos = useMemo(() => latestTodos(events), [events]);
  const gone = goneView === view;
  const busy = useMemo(() => !gone && lastBusy(events), [events, gone]);
  const status = chatStatus({ inFlight: visible.filter((m) => m.sending).length, pending: visible.length, busy, error });

  return { items, todos, status, busy: busy || status === 'submitted', error, send, interrupt };
}
