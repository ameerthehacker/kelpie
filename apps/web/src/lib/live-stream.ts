import { EventStreamContentType, fetchEventSource, type EventSourceMessage } from '@microsoft/fetch-event-source';

export interface LiveStreamOptions {
  /** Called on every fresh connection, so it can resume where the last one stopped. */
  url: () => string;
  /** Handlers by SSE event name. */
  on: Record<string, (msg: EventSourceMessage) => void>;
  /** The resource is gone for good (404); the stream stops. */
  onGone?: () => void;
  /** An error to show while disconnected, or undefined once connected again. */
  onStatus: (error: string | undefined) => void;
}

const DEAD_AFTER = 40_000; // the daemon pings every 15s
const RETRY_AFTER = 2_000;

class Gone extends Error {}

/**
 * An SSE subscription that survives the daemon going away. fetch-event-source
 * does the retrying (with Last-Event-ID) and lets us see a 404; on top of it,
 * a watchdog reconnects a socket that went silent without closing.
 */
export function liveStream(opts: LiveStreamOptions): () => void {
  let conn: AbortController | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const alive = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      conn?.abort();
      connect();
    }, DEAD_AFTER);
  };

  const connect = () => {
    if (disposed) return;
    const current = (conn = new AbortController());
    fetchEventSource(opts.url(), {
      signal: current.signal,
      openWhenHidden: true, // keep sidebar statuses live in a background tab
      async onopen(res) {
        if (res.status === 404) throw new Gone();
        if (!res.ok || !res.headers.get('content-type')?.startsWith(EventStreamContentType)) throw new Error(`${res.status}`);
        alive();
        opts.onStatus(undefined);
      },
      onmessage(msg) {
        alive();
        opts.on[msg.event]?.(msg);
      },
      onclose() {
        throw new Error('closed'); // the daemon ended it (restart, or deletion): retry and find out which
      },
      onerror(err) {
        if (err instanceof Gone) {
          clearTimeout(watchdog);
          opts.onGone?.();
          throw err; // stop retrying
        }
        opts.onStatus('Lost connection to the Kelpie daemon. Retrying…');
        return RETRY_AFTER;
      },
    }).catch(() => {});
  };

  connect();
  return () => {
    disposed = true;
    conn?.abort();
    clearTimeout(watchdog);
  };
}
