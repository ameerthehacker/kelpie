import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_AGENTS, parseAgents, saveSettingsOptions, settingsStream, SETTINGS, stepAgents, workingLabel, type Settings } from '../src/lib/settings.js';

describe('the agent limit', () => {
  it('steps by one, never past the range', () => {
    expect(stepAgents(4, 1)).toBe(5);
    expect(stepAgents(4, -1)).toBe(3);
    expect(stepAgents(MAX_AGENTS.min, -1)).toBe(MAX_AGENTS.min);
    expect(stepAgents(MAX_AGENTS.max, 1)).toBe(MAX_AGENTS.max);
  });

  it('takes a whole number in range, and says what is wrong with anything else', () => {
    expect(parseAgents(' 7 ')).toEqual({ value: 7 });
    expect(parseAgents('16')).toEqual({ value: 16 });
    expect(parseAgents('0')).toEqual({ error: 'Choose from 1 to 16.' });
    expect(parseAgents('17')).toEqual({ error: 'Choose from 1 to 16.' });
    for (const bad of ['', 'four', '2.5', '-3', '1e1']) expect(parseAgents(bad)).toEqual({ error: 'Enter a whole number from 1 to 16.' });
  });

  it('reads working agents against the limit', () => {
    expect(workingLabel(3, 6)).toBe('3 of 6 working');
    expect(workingLabel(5, 2)).toBe('5 of 2 working');
    expect(workingLabel(3, undefined)).toBe('3 working');
  });
});

/** A PUT the test answers by hand: resolve with the daemon's answer, or reject with its refusal. */
function deferredPuts() {
  const calls: { body: Partial<Settings>; answer: (status: number, body: unknown) => void }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((resolve) => {
        calls.push({ body: JSON.parse(init.body as string), answer: (status, body) => resolve(new Response(JSON.stringify(body), { status })) });
      });
    }),
  );
  return calls;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('saving settings', () => {
  afterEach(() => vi.unstubAllGlobals());

  const setup = () => {
    const client = new QueryClient();
    client.setQueryData<Settings>(SETTINGS, { maxAgents: 4 });
    const save = (patch: Partial<Settings>) => new MutationObserver(client, saveSettingsOptions(client)).mutate(patch).catch(() => undefined);
    return { client, save, shown: () => client.getQueryData<Settings>(SETTINGS)?.maxAgents };
  };

  it('shows a change at once, and keeps the daemon’s answer', async () => {
    const puts = deferredPuts();
    const { save, shown } = setup();
    const done = save({ maxAgents: 6 });
    await flush();
    expect(shown()).toBe(6);
    expect(puts.map((p) => p.body)).toEqual([{ maxAgents: 6 }]);
    puts[0]!.answer(200, { maxAgents: 6 });
    await done;
    expect(shown()).toBe(6);
  });

  it('puts the value back when the daemon refuses it', async () => {
    const puts = deferredPuts();
    const { save, shown } = setup();
    const done = save({ maxAgents: 9 });
    await flush();
    expect(shown()).toBe(9);
    puts[0]!.answer(400, { error: 'maxAgents can be at most 16' });
    await done;
    expect(shown()).toBe(4);
  });

  it('sends a quick run of changes one at a time, in order, and lands on the last', async () => {
    const puts = deferredPuts();
    const { save, shown } = setup();
    const first = save({ maxAgents: 5 });
    const second = save({ maxAgents: 6 });
    await flush();
    // Both show at once; the second waits for the first's answer before it goes out.
    expect(shown()).toBe(6);
    expect(puts).toHaveLength(1);
    puts[0]!.answer(200, { maxAgents: 5 });
    await first;
    await flush();
    // The first's answer doesn't undo the second, still going out.
    expect(shown()).toBe(6);
    expect(puts.map((p) => p.body)).toEqual([{ maxAgents: 5 }, { maxAgents: 6 }]);
    puts[1]!.answer(400, { error: 'nope' });
    await second;
    // Refused: back to what the daemon has, the first change.
    expect(shown()).toBe(5);
  });

  it('takes changes from the stream, but not over a save still going out', async () => {
    const puts = deferredPuts();
    const { client, save, shown } = setup();
    const on = settingsStream(client);
    const event = (s: Settings) => on.settings!({ id: '', event: 'settings', data: JSON.stringify(s), retry: undefined });
    event({ maxAgents: 8 });
    expect(shown()).toBe(8);
    const done = save({ maxAgents: 10 });
    await flush();
    event({ maxAgents: 2 });
    expect(shown()).toBe(10);
    puts[0]!.answer(200, { maxAgents: 10 });
    await done;
    event({ maxAgents: 3 });
    expect(shown()).toBe(3);
  });
});
