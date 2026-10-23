import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KelpieEvent } from '@kelpie/protocol';
import { buildChat, type ChatItem } from '@/lib/chat';

export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error';

const STORAGE_KEY = 'kelpie.sessionId';

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

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

interface SessionInfo {
  id: string;
  cwd: string;
  busy: boolean;
}

/** One chat session on the daemon: its KEF log, live over SSE, plus send / interrupt. */
export function useSession() {
  const [session, setSession] = useState<SessionInfo | undefined>();
  const [events, setEvents] = useState<KelpieEvent[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Sent turns not yet echoed back by the harness, shown right away so the chat doesn't look idle.
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();

  // Reattach to the session from a previous page load, if the daemon still has it.
  useEffect(() => {
    const id = readStoredId();
    if (!id) return;
    fetch(`/api/sessions/${id}`)
      .then((r) => (r.ok ? r.json() : undefined))
      .then((info: SessionInfo | undefined) => (info ? setSession(info) : storeId(undefined)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!session) return;
    const source = new EventSource(`/api/sessions/${session.id}/events`);
    source.addEventListener('kef', (e) => {
      const index = Number((e as MessageEvent).lastEventId);
      const event = JSON.parse((e as MessageEvent).data) as KelpieEvent;
      if (event.kind === 'activity' && event.data.busy) setSubmitting(false);
      if (event.kind === 'message' && event.data.role === 'user' && !event.parentCallId) setPending((p) => p.slice(1));
      setEvents((prev) => {
        if (index < prev.length) return prev; // already have it (replay after reconnect)
        const next = prev.slice();
        next[index] = event;
        return next;
      });
    });
    source.onerror = () => setError(source.readyState === EventSource.CLOSED ? 'Lost connection to the Kelpie daemon.' : undefined);
    source.onopen = () => setError(undefined);
    return () => source.close();
  }, [session]);

  const send = useCallback(
    async (text: string) => {
      setError(undefined);
      setSubmitting(true);
      setPending((p) => [...p, text]);
      try {
        let current = session;
        if (!current) {
          current = await post<SessionInfo>('/api/sessions', {});
          storeId(current.id);
          setSession(current);
        }
        await post(`/api/sessions/${current.id}/messages`, { text });
      } catch (err) {
        setSubmitting(false);
        setPending((p) => p.filter((t) => t !== text));
        setError((err as Error).message);
        throw err;
      }
    },
    [session],
  );

  const interrupt = useCallback(async () => {
    if (session) await post(`/api/sessions/${session.id}/interrupt`, {}).catch((err) => setError(err.message));
  }, [session]);

  const reset = useCallback(() => {
    storeId(undefined);
    setSession(undefined);
    setEvents([]);
    setPending([]);
    setSubmitting(false);
    setError(undefined);
  }, []);

  const items = useMemo(
    () => [...buildChat(events), ...pending.map((text, i): ChatItem => ({ role: 'user', id: `pending-${i}`, text }))],
    [events, pending],
  );
  const busy = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === 'activity') return e.data.busy;
    }
    return false;
  }, [events]);
  const status: ChatStatus = submitting ? 'submitted' : busy ? 'streaming' : error ? 'error' : 'ready';

  return { session, items, status, busy: busy || submitting, error, send, interrupt, reset };
}
