import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KelpieEvent } from '@kelpie/protocol';
import { buildChat, type ChatItem } from '@/lib/chat';
import { chatStatus, lastBusy, settlePending, type PendingMessage } from '@/lib/session-state';

export type { ChatStatus } from '@/lib/session-state';

const STORAGE_KEY = 'kelpie.sessionId';
const LOST = 'The daemon no longer has this chat (it probably restarted). Your next message starts a new one.';

function readStoredId(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeId(id: string | undefined): void {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(json.error ?? `${res.status} ${res.statusText}`, res.status);
  return json as T;
}

const isGone = (err: unknown) => err instanceof HttpError && err.status === 404;

interface SessionInfo {
  id: string;
  cwd: string;
  busy: boolean;
}

/** One chat session on the daemon: its KEF log, live over SSE, plus send / interrupt. */
export function useSession() {
  const [session, setSession] = useState<SessionInfo | undefined>();
  const [events, setEvents] = useState<KelpieEvent[]>([]);
  const [inFlight, setInFlight] = useState(0);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [error, setError] = useState<string | undefined>();
  // The daemon dropped the session; its transcript stays on screen until the next send.
  const [lost, setLost] = useState(false);

  // Read by send() so quick successive calls see the session the first one created.
  const sessionRef = useRef<SessionInfo | undefined>(undefined);
  const creating = useRef<Promise<SessionInfo> | undefined>(undefined);
  const nextPendingId = useRef(0);

  const adopt = useCallback((info: SessionInfo | undefined) => {
    sessionRef.current = info;
    storeId(info?.id);
    setSession(info);
    setLost(false);
  }, []);

  const markLost = useCallback(() => {
    sessionRef.current = undefined;
    storeId(undefined);
    setLost(true);
    setPending([]);
    setError(LOST);
  }, []);

  // Reattach to the session from a previous page load, if the daemon still has it.
  useEffect(() => {
    const id = readStoredId();
    if (!id) return;
    fetch(`/api/sessions/${id}`)
      .then((r) => (r.ok ? r.json() : undefined))
      .then((info: SessionInfo | undefined) => (info ? adopt(info) : storeId(undefined)))
      .catch(() => {});
  }, [adopt]);

  useEffect(() => {
    if (!session) return;
    setEvents([]);
    let seen = 0; // log indices received so far
    let buffer: KelpieEvent[] = [];
    let frame = 0;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    // A long log replays as thousands of SSE messages; fold them in once per frame, not once each.
    const flush = () => {
      frame = 0;
      const batch = buffer;
      buffer = [];
      setEvents((prev) => prev.concat(batch));
      setPending((p) => settlePending(p, batch));
    };

    const onKef = (e: MessageEvent) => {
      const index = Number(e.lastEventId);
      if (index < seen) return;
      seen = index + 1;
      buffer.push(JSON.parse(e.data) as KelpieEvent);
      frame ||= requestAnimationFrame(flush);
    };

    // The daemon pings every 15s; a stream silent for longer is dead even if the socket looks open.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        source?.close();
        void check();
      }, 40_000);
    };

    const connect = () => {
      source = new EventSource(`/api/sessions/${session.id}/events?after=${seen - 1}`);
      source.addEventListener('kef', (e) => (alive(), onKef(e)));
      source.addEventListener('ping', alive);
      source.onopen = () => (alive(), setError(undefined));
      source.onerror = () => {
        if (source!.readyState !== EventSource.CLOSED) return; // the browser is retrying by itself
        clearTimeout(watchdog);
        source!.close();
        void check();
      };
    };

    // The stream was refused for good: either the daemon is down, or it is back without this session.
    const check = async () => {
      if (disposed) return;
      const res = await fetch(`/api/sessions/${session.id}`).catch(() => undefined);
      if (disposed) return;
      if (res?.status === 404) return markLost();
      if (res?.ok) return connect();
      setError('Lost connection to the Kelpie daemon. Retrying…');
      retry = setTimeout(check, 2000);
    };

    connect();
    return () => {
      disposed = true;
      source?.close();
      clearTimeout(retry);
      clearTimeout(watchdog);
      cancelAnimationFrame(frame);
    };
  }, [session, markLost]);

  const send = useCallback(
    async (text: string) => {
      const id = nextPendingId.current++;
      setError(undefined);
      setPending((p) => [...p, { id, text }]);
      setInFlight((n) => n + 1);
      try {
        const current =
          sessionRef.current ??
          (await (creating.current ??= post<SessionInfo>('/api/sessions', {})
            .then((info) => (adopt(info), info))
            .finally(() => (creating.current = undefined))));
        await post(`/api/sessions/${current.id}/messages`, { text });
      } catch (err) {
        setPending((p) => p.filter((m) => m.id !== id));
        if (isGone(err)) markLost();
        else setError((err as Error).message);
        throw err;
      } finally {
        setInFlight((n) => n - 1);
      }
    },
    [adopt, markLost],
  );

  const interrupt = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    await post(`/api/sessions/${current.id}/interrupt`, {}).catch((err) => (isGone(err) ? markLost() : setError(err.message)));
  }, [markLost]);

  const reset = useCallback(() => {
    adopt(undefined);
    setEvents([]);
    setPending([]);
    setError(undefined);
  }, [adopt]);

  const items = useMemo(
    () => [...buildChat(events), ...pending.map(({ id, text }): ChatItem => ({ role: 'user', id: `pending-${id}`, text }))],
    [events, pending],
  );
  const busy = useMemo(() => !lost && lastBusy(events), [events, lost]);
  const status = chatStatus({ inFlight, pending: pending.length, busy, error });

  return { session, items, status, busy: busy || status === 'submitted', error, send, interrupt, reset };
}
