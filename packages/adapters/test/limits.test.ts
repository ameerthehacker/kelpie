import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EventOf, KelpieEvent } from '@kelpie/protocol';
import { ClaudeCodeParser, claudeLimitOf, resetFromText } from '../src/index.js';

const at = (iso: string) => new Date(iso);
const reset = (text: string, now: string) => resetFromText(text, at(now))?.toISOString();

describe('resetFromText', () => {
  it('reads the CLI message, in the zone it names', () => {
    // As captured from Claude Code 2.1.308 (fixtures/claude-code/usage-limit.jsonl): 6pm IST is 12:30 UTC.
    expect(reset("You've hit your session limit · resets 6pm (Asia/Calcutta)", '2026-10-26T08:43:20Z')).toBe('2026-10-26T12:30:00.000Z');
    expect(reset("You've hit your session limit · resets 12:50pm (Asia/Calcutta)", '2026-10-26T05:00:00Z')).toBe('2026-10-26T07:20:00.000Z');
    expect(reset('resets 10:30pm (America/New_York)', '2026-10-26T12:00:00Z')).toBe('2026-10-27T02:30:00.000Z');
  });

  it('puts a time already gone tomorrow, across midnight in its zone', () => {
    // 23:30 in Kolkata: 1am is the next day there (while it is still the 26th in UTC).
    expect(reset('resets 1am (Asia/Calcutta)', '2026-10-26T18:00:00Z')).toBe('2026-10-26T19:30:00.000Z');
    // 11pm New York, "resets 9pm": tomorrow's.
    expect(reset('resets 9pm (America/New_York)', '2026-10-27T03:00:00Z')).toBe('2026-10-28T01:00:00.000Z');
  });

  it('keeps a reset only just gone as now, not tomorrow', () => {
    expect(reset('resets 6pm (Asia/Calcutta)', '2026-10-26T12:30:40Z')).toBe('2026-10-26T12:30:00.000Z');
  });

  it('places wall times across DST changes', () => {
    // New York falls back at 2am on Nov 1 2026: 00:30 is EDT, 4am is EST (UTC−5).
    expect(reset('resets 4am (America/New_York)', '2026-11-01T04:30:00Z')).toBe('2026-11-01T09:00:00.000Z');
    // And springs forward on Mar 14 2027: 1:30 is EST, 5am is EDT (UTC−4).
    expect(reset('resets 5am (America/New_York)', '2027-03-14T06:30:00Z')).toBe('2027-03-14T09:00:00.000Z');
    // Tomorrow's 9am in London, after the clocks went back on Oct 25: GMT.
    expect(reset('resets 9am (Europe/London)', '2026-10-24T20:00:00Z')).toBe('2026-10-25T09:00:00.000Z');
  });

  it('reads dated resets, with or without a year', () => {
    expect(reset('resets Oct 27, 9am (Europe/London)', '2026-10-26T08:00:00Z')).toBe('2026-10-27T09:00:00.000Z');
    expect(reset("You've hit your weekly limit · resets Oct 30, 2:15pm (Asia/Calcutta)", '2026-10-26T08:00:00Z')).toBe('2026-10-30T08:45:00.000Z');
    expect(reset('resets Oct 27, 2027, 9:15am (Asia/Calcutta)', '2026-10-26T08:00:00Z')).toBe('2027-10-27T03:45:00.000Z');
    // A date gone by is next year's.
    expect(reset('resets Jan 2, 9am (UTC)', '2026-12-30T10:00:00Z')).toBe('2027-01-02T09:00:00.000Z');
  });

  it('reads "resets in"', () => {
    expect(reset('Fast mode resets in 2h 14m', '2026-10-26T08:00:00Z')).toBe('2026-10-26T10:14:00.000Z');
    expect(reset('resets in 45m', '2026-10-26T08:00:00Z')).toBe('2026-10-26T08:45:00.000Z');
  });

  it('gives up on what it cannot place', () => {
    expect(reset('resets 6pm (Mars/Olympus_Mons)', '2026-10-26T08:00:00Z')).toBeUndefined();
    expect(reset("You've hit your session limit", '2026-10-26T08:00:00Z')).toBeUndefined();
    expect(reset('resets soon', '2026-10-26T08:00:00Z')).toBeUndefined();
  });
});

const DIR = join(import.meta.dirname, '../fixtures/claude-code');
const replay = (name: string) => {
  const parser = new ClaudeCodeParser({ runId: 'run', now: () => '2026-10-26T08:43:20.000Z' });
  return readFileSync(join(DIR, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l, i) => parser.parse(JSON.parse(l), i + 1));
};
const ended = (evs: KelpieEvent[]) => evs.filter((e): e is EventOf<'turn.ended'> => e.kind === 'turn.ended');
const turnEnded = (data: EventOf<'turn.ended'>['data']): KelpieEvent => ({ id: 'r:9', runId: 'r', seq: 9, ts: '2026-10-26T08:43:20.000Z', harness: 'claude-code', kind: 'turn.ended', data });

describe('claude-code usage limit stops', () => {
  it('tags the failed turn with the reset the CLI reported', () => {
    const [turn] = ended(replay('usage-limit'));
    expect(turn!.data).toMatchObject({
      status: 'failed',
      error: "You've hit your session limit · resets 6pm (Asia/Calcutta)",
      limit: { resetsAt: '2026-10-26T12:30:00.000Z', window: 'five_hour' },
    });
    expect(claudeLimitOf(turn!)).toEqual({ message: "You've hit your session limit · resets 6pm (Asia/Calcutta)", resetsAt: at('2026-10-26T12:30:00Z') });
  });

  it("reads the CLI's words when the turn was not tagged (logs from before)", () => {
    const stop = claudeLimitOf(turnEnded({ status: 'failed', error: "You've hit your session limit · resets 10pm (Asia/Calcutta)" }), at('2026-10-26T08:43:20Z'));
    expect(stop?.resetsAt?.toISOString()).toBe('2026-10-26T16:30:00.000Z');
    expect(claudeLimitOf(turnEnded({ status: 'failed', error: "You've hit your Opus limit" }))).toEqual({ message: "You've hit your Opus limit" });
  });

  it('leaves other failures, and other turns, alone', () => {
    expect(claudeLimitOf(turnEnded({ status: 'failed', error: 'API Error: 500 Internal Server Error' }))).toBeUndefined();
    expect(claudeLimitOf(turnEnded({ status: 'completed', resultText: "You've hit your session limit" }))).toBeUndefined();
    expect(ended(replay('bash-fail')).every((e) => !e.data.limit)).toBe(true);
  });
});
