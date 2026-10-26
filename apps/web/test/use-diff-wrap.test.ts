/// <reference lib="dom" />
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffPlace } from '../src/hooks/use-diff-wrap.js';

// React only runs effects inside `act` when it is told it is under test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let seen: Record<string, [boolean, () => void]>;

/** The hook as a fresh page load has it: its module-level cache starts empty. */
async function mount(...places: DiffPlace[]) {
  vi.resetModules();
  const { useDiffWrap } = await import('../src/hooks/use-diff-wrap.js');
  function Probe() {
    for (const p of places) seen[p] = useDiffWrap(p);
    return null;
  }
  act(() => root.render(createElement(Probe)));
}

describe('useDiffWrap', () => {
  beforeEach(() => {
    localStorage.clear();
    seen = {};
    root = createRoot(document.createElement('div'));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
  });

  it('scrolls by default, except in the narrow agent pane', async () => {
    await mount('changes', 'agent', 'full');
    expect(seen.changes![0]).toBe(false);
    expect(seen.agent![0]).toBe(true);
    expect(seen.full![0]).toBe(false);
  });

  it('remembers the switch across page loads', async () => {
    await mount('changes');
    act(() => seen.changes![1]());
    expect(seen.changes![0]).toBe(true);
    expect(localStorage.getItem('kelpie.diff-wrap.changes')).toBe('1');
    await mount('changes');
    expect(seen.changes![0]).toBe(true);
  });

  it('keeps each place to its own switch', async () => {
    await mount('changes', 'full');
    act(() => seen.full![1]());
    expect(seen.full![0]).toBe(true);
    expect(seen.changes![0]).toBe(false);
  });

  it('keeps the same toggle across renders', async () => {
    await mount('changes');
    const first = seen.changes![1];
    act(() => first());
    expect(seen.changes![1]).toBe(first);
  });

  it('follows a change made in another tab', async () => {
    await mount('changes');
    localStorage.setItem('kelpie.diff-wrap.changes', '1');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'kelpie.diff-wrap.changes', newValue: '1' }));
    });
    expect(seen.changes![0]).toBe(true);
  });

  it('works, unremembered, when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    await mount('changes', 'agent');
    expect(seen.changes![0]).toBe(false);
    expect(seen.agent![0]).toBe(true);
    act(() => seen.changes![1]());
    expect(seen.changes![0]).toBe(true);
  });
});
