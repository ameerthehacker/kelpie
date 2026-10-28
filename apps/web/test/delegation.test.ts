import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeDelegation, DEFAULT_DELEGATION, DELEGATION_INFO, DELEGATIONS, delegationOf } from '../src/lib/delegation.js';
import type { RoundUp } from '../src/lib/round-ups.js';
import { withPatch, type SettingsWithLimits } from '../src/lib/settings.js';

afterEach(() => vi.unstubAllGlobals());

describe('delegation levels', () => {
  it('are Solo, Balanced and Delegate, Balanced by default, each with a label and a line', () => {
    expect(DELEGATIONS).toEqual(['solo', 'balanced', 'delegate']);
    expect(DEFAULT_DELEGATION).toBe('balanced');
    expect(DELEGATIONS.map((d) => DELEGATION_INFO[d].label)).toEqual(['Solo', 'Balanced', 'Delegate']);
    for (const d of DELEGATIONS) expect(DELEGATION_INFO[d].detail).toMatch(/\S.*\.$/);
  });

  it('reads a level from the daemon, and the default for one missing or unknown', () => {
    expect(delegationOf('solo')).toBe('solo');
    expect(delegationOf('delegate')).toBe('delegate');
    expect(delegationOf(undefined)).toBe('balanced');
    expect(delegationOf('everything')).toBe('balanced');
  });

  it('puts the default level back when a settings patch clears it', () => {
    const s = { maxAgents: 4, autoResume: true, useUserMcp: false, mcpAllow: [], delegation: 'solo', limits: { maxAgents: { min: 1, max: 16, default: 4 } } } satisfies SettingsWithLimits;
    expect(withPatch(s, { delegation: 'delegate' }).delegation).toBe('delegate');
    expect(withPatch(s, { delegation: null }).delegation).toBe('balanced');
  });
});

describe('changing a round-up’s level', () => {
  const roundUp = { id: 'r1', mode: 'auto', delegation: 'balanced' } as RoundUp;
  const other = { id: 'r2', mode: 'auto', delegation: 'balanced' } as RoundUp;
  const setup = (status: number) => {
    const calls: { url: string; method: string | undefined; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(status === 200 ? { ...roundUp, delegation: 'solo' } : { error: 'nope' }), { status, headers: { 'content-type': 'application/json' } });
      }),
    );
    const client = new QueryClient();
    client.setQueryData(['round-ups'], [roundUp, other]);
    return { calls, client };
  };

  it('PATCHes the round-up with the level, showing it at once', async () => {
    const { calls, client } = setup(200);
    const done = changeDelegation(client, 'r1', 'solo');
    expect(client.getQueryData<RoundUp[]>(['round-ups'])?.map((r) => r.delegation)).toEqual(['solo', 'balanced']);
    await done;
    expect(calls).toEqual([{ url: '/api/sessions/r1', method: 'PATCH', body: { delegation: 'solo' } }]);
  });

  it('refetches to put it back, and rejects, when the daemon refuses', async () => {
    const { client } = setup(400);
    const refetch = vi.spyOn(client, 'invalidateQueries');
    await expect(changeDelegation(client, 'r1', 'delegate')).rejects.toThrow('nope');
    expect(refetch).toHaveBeenCalledWith({ queryKey: ['round-ups'] });
    expect(refetch).toHaveBeenCalledWith({ queryKey: ['round-up', 'r1'] });
  });
});
