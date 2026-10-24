import { describe, expect, it } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import { chatStatus, settlePending, unechoed } from '../src/lib/session-state.js';

const ev = (kind: string, data: unknown, parentCallId?: string) => ({ kind, data, parentCallId }) as unknown as KelpieEvent;
const echo = (text: string, parentCallId?: string) => ev('message', { role: 'user', text }, parentCallId);
const pending = (...texts: string[]) => texts.map((text, id) => ({ id, text }));

describe('settlePending', () => {
  it('drops the oldest pending message per top-level echo, even when texts repeat', () => {
    expect(settlePending(pending('yes', 'yes', 'no'), [echo('yes')])).toEqual([{ id: 1, text: 'yes' }, { id: 2, text: 'no' }]);
  });

  it('is not settled by turns Kelpie sent itself', () => {
    const p = pending('mine');
    expect(settlePending(p, [ev('message', { role: 'user', text: '<kelpie-notification>…', source: 'kelpie' })])).toBe(p);
    expect(settlePending(p, [ev('message', { role: 'user', text: 'mine', source: 'user' })])).toEqual([]);
  });

  it('ignores sub-agent prompts and assistant messages', () => {
    const p = pending('a');
    expect(settlePending(p, [echo('task', 'call-1'), ev('message', { role: 'assistant', text: 'hi' })])).toBe(p);
  });

  it('drops everything when the process exits, but keeps what a later run echoes after', () => {
    expect(settlePending(pending('lost', 'lost too'), [ev('process.exited', {})])).toEqual([]);
    expect(settlePending(pending('a'), [ev('process.exited', {}), echo('a')])).toEqual([]);
  });
});

describe('unechoed', () => {
  const sent = (text: string, id: number, after: number) => ({ id, text, after });

  it('keeps a message until the log echoes it, counting only what was logged after it was sent', () => {
    const log = [echo('earlier'), ev('activity', { busy: true })];
    const first = sent('first', 1, 2);
    expect(unechoed([first], log)).toEqual([first]);
    // An echo from before the send (index 0) settles nothing; one after it does.
    expect(unechoed([first], [...log, echo('first')])).toEqual([]);
  });

  it('settles messages in the order they were sent, and ignores the orchestrator’s own turns', () => {
    const a = sent('a', 1, 0);
    const b = sent('b', 2, 1);
    const log = [ev('message', { role: 'user', text: 'brief', source: 'orchestrator' }), echo('a')];
    expect(unechoed([a, b], log)).toEqual([b]);
  });
});

describe('chatStatus', () => {
  const base = { inFlight: 0, pending: 0, busy: false, error: undefined };

  it('returns to streaming once a follow-up sent mid-turn is accepted', () => {
    // The agent was already busy, so no new activity event will come; the status must not wait for one.
    expect(chatStatus({ ...base, busy: true, inFlight: 1, pending: 1 })).toBe('submitted');
    expect(chatStatus({ ...base, busy: true, pending: 1 })).toBe('streaming');
  });

  it('stays submitted between the daemon accepting a turn and the agent reporting busy', () => {
    expect(chatStatus({ ...base, pending: 1 })).toBe('submitted');
  });

  it('is ready, or error, when idle', () => {
    expect(chatStatus(base)).toBe('ready');
    expect(chatStatus({ ...base, error: 'boom' })).toBe('error');
  });
});
