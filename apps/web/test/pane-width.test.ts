import { describe, expect, it } from 'vitest';
import { clampPaneWidth, loadPaneWidth, PANE_DEFAULT, PANE_MIN, savePaneWidth } from '../src/lib/pane-width.js';

function memory(initial?: string) {
  const items = new Map<string, string>(initial === undefined ? [] : [['kelpie.pane-width', initial]]);
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
}

describe('clampPaneWidth', () => {
  it('keeps a width in whole pixels and above the minimum', () => {
    expect(clampPaneWidth(100)).toBe(PANE_MIN);
    expect(clampPaneWidth(500.4)).toBe(500);
    expect(clampPaneWidth(5000)).toBe(5000);
  });
});

describe('loadPaneWidth / savePaneWidth', () => {
  it('starts at the default', () => {
    expect(loadPaneWidth(memory())).toBe(PANE_DEFAULT);
  });

  it('comes back at the width it was left', () => {
    const storage = memory();
    savePaneWidth(612.6, storage);
    expect(storage.items.get('kelpie.pane-width')).toBe('613');
    expect(loadPaneWidth(storage)).toBe(613);
  });

  it('forgets the width once reset to the default', () => {
    const storage = memory('600');
    savePaneWidth(PANE_DEFAULT, storage);
    expect(storage.items.size).toBe(0);
  });

  it('ignores a saved value that is not a width, and holds a narrow one at the minimum', () => {
    expect(loadPaneWidth(memory('wide'))).toBe(PANE_DEFAULT);
    expect(loadPaneWidth(memory('-5'))).toBe(PANE_DEFAULT);
    expect(loadPaneWidth(memory('200'))).toBe(PANE_MIN);
  });

  it('falls back to the default when storage is unavailable', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadPaneWidth(broken)).toBe(PANE_DEFAULT);
    // No localStorage here (node): reaching for it throws, and is caught.
    expect(loadPaneWidth()).toBe(PANE_DEFAULT);
    expect(() => savePaneWidth(600)).not.toThrow();
  });
});
