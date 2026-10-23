import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { KelpieEvent } from '@kelpie/protocol';
import { claudeCode, type RunSpec } from '../src/index.js';

const FAKE = join(import.meta.dirname, 'fake-claude.mjs');
const FIXTURES = join(import.meta.dirname, '../fixtures/claude-code');

beforeAll(() => chmodSync(FAKE, 0o755));

function start(fixture: string, extra: Partial<RunSpec> & { hang?: boolean } = {}) {
  const { hang, ...spec } = extra;
  return claudeCode.start({
    cwd: tmpdir(),
    bin: FAKE,
    runDir: mkdtempSync(join(tmpdir(), 'kelpie-run-')),
    env: { FAKE_FIXTURE: join(FIXTURES, `${fixture}.jsonl`), FAKE_HANG: hang ? '1' : '0' },
    ...spec,
  });
}

async function collect(run: ReturnType<typeof start>, onEvent?: (e: KelpieEvent) => void | Promise<void>) {
  const events: KelpieEvent[] = [];
  for await (const e of run.events) {
    events.push(e);
    await onEvent?.(e);
  }
  return events;
}

describe('claude-code spawn', () => {
  it('runs a turn end to end and tees the raw stream', async () => {
    const run = start('plain', { prompt: 'What is 2+2?' });
    expect(run.busy).toBe(true);
    const events = await collect(run, async (e) => {
      if (e.kind === 'turn.ended') {
        expect(run.busy).toBe(false);
        await run.stop();
      }
    });
    expect(events.map((e) => e.kind)).toEqual(['session.started', 'message', 'message', 'rate_limit', 'usage', 'turn.ended', 'process.exited']);
    events.forEach((e) => expect(KelpieEvent.safeParse(e).error).toBeUndefined());
    expect(run.harnessSessionId).toBeTruthy();

    const raw = readFileSync(join(run.runDir, 'raw.jsonl'), 'utf8').split('\n').filter(Boolean);
    const turnEnded = events.find((e) => e.kind === 'turn.ended')!;
    expect(JSON.parse(raw[turnEnded.rawLine! - 1]!).type).toBe('result');
  });

  it('stays busy until queued turns are taken in, even when they merge into one result', async () => {
    const run = start('queued');
    run.send('first');
    run.send('second');
    run.send('third');
    const ends: boolean[] = [];
    const events = await collect(run, async (e) => {
      if (e.kind === 'turn.ended') {
        ends.push(run.busy);
        await run.stop();
      }
    });
    expect(ends).toEqual([false]);
    expect(events.filter((e) => e.kind === 'message' && e.data.role === 'user')).toHaveLength(3);
  });

  it('refuses to reuse a run directory', async () => {
    const run = start('plain', { prompt: 'hi' });
    await collect(run, (e) => void (e.kind === 'turn.ended' && run.stop()));
    expect(() => start('plain', { runDir: run.runDir })).toThrow(/already holds a run/);
  });

  it('rejects sends after stop', async () => {
    const run = start('plain');
    const stopped = run.stop();
    expect(() => run.send('late')).toThrow(/stopping|exited/);
    await stopped;
    expect(run.exited).toBe(true);
  });

  it('kills a harness that ignores an interrupt, and reports the turn as interrupted', { timeout: 15_000 }, async () => {
    const run = start('plain', { prompt: 'hang', hang: true });
    const events = await collect(run, async (e) => {
      if (e.kind === 'session.started') await run.interrupt();
    });
    const kinds = events.map((e) => e.kind);
    expect(kinds.slice(-2)).toEqual(['turn.ended', 'process.exited']);
    expect(events.at(-2)!.data).toMatchObject({ status: 'interrupted' });
  });
});
