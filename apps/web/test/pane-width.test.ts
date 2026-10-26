import { describe, expect, it } from 'vitest';
import { CHAT_MIN, clampPaneWidth, loadPaneWidth, PANE_DEFAULT, PANE_MIN, paneLimits, savePaneWidth } from '../src/lib/pane-width.js';

function memory(initial?: string) {
  const items = new Map<string, string>(initial === undefined ? [] : [['kelpie.pane-width', initial]]);
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
}

describe('paneLimits', () => {
  it('lets the pane take up to 70% of a wide room', () => {
    expect(paneLimits(2000)).toEqual({ min: PANE_MIN, max: 1400 });
  });

  it('keeps the chat at its minimum when 70% would leave it less', () => {
    expect(paneLimits(1200)).toEqual({ min: PANE_MIN, max: 1200 - CHAT_MIN });
  });

  it('shrinks the pane below its minimum rather than the chat when there is no room for both', () => {
    expect(paneLimits(700)).toEqual({ min: 280, max: 280 });
    expect(paneLimits(300)).toEqual({ min: 0, max: 0 });
  });
});

describe('clampPaneWidth', () => {
  it('holds a width within the limits for the room', () => {
    expect(clampPaneWidth(100, 1600)).toBe(PANE_MIN);
    expect(clampPaneWidth(5000, 1600)).toBe(1120);
    expect(clampPaneWidth(500.4, 1600)).toBe(500);
  });

  it('only keeps it above the minimum with no room measured', () => {
    expect(clampPaneWidth(100)).toBe(PANE_MIN);
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
    expect(loadPaneWidth(undefined)).toBe(PANE_DEFAULT);
  });
});
