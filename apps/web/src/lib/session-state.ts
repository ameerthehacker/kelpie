import type { KelpieEvent } from '@kelpie/protocol';

export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error';

/** A sent turn not yet echoed back by the harness, shown right away so the chat doesn't look idle. */
export interface PendingMessage {
  id: number;
  text: string;
}

/**
 * Drops pending messages as a batch of new log events settles them: each
 * top-level user echo takes the oldest one, and a process exit takes them all
 * (whatever it had not read from stdin yet is gone).
 */
export function settlePending(pending: PendingMessage[], batch: readonly KelpieEvent[]): PendingMessage[] {
  let next = pending;
  for (const ev of batch) {
    if (ev.kind === 'process.exited') next = [];
    else if (ev.kind === 'message' && ev.data.role === 'user' && !ev.parentCallId) next = next.slice(1);
  }
  return next;
}

/** Busy as of the last `activity` event in the log. */
export function lastBusy(events: readonly KelpieEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'activity') return e.data.busy;
  }
  return false;
}

/**
 * `submitted` covers a request in flight, and the gap between the daemon
 * accepting a turn and the harness reporting busy. A turn queued while the
 * agent is already busy goes straight back to `streaming`.
 */
export function chatStatus(s: { inFlight: number; pending: number; busy: boolean; error: string | undefined }): ChatStatus {
  if (s.inFlight > 0 || (s.pending > 0 && !s.busy)) return 'submitted';
  if (s.busy) return 'streaming';
  return s.error ? 'error' : 'ready';
}
