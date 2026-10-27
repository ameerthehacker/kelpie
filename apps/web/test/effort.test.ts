import { describe, expect, it } from 'vitest';
import { Effort } from '@kelpie/protocol';
import { EFFORT_INFO, EFFORTS, effortLabel, effortOf, effortPatch, effortSuffix } from '../src/lib/effort.js';

describe('the effort picker', () => {
  it('offers the default and then every level the CLI takes, lowest first, each with a label and a hint', () => {
    expect(EFFORTS).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    for (const e of EFFORTS) {
      expect(EFFORT_INFO[e].short.length).toBeLessThanOrEqual(7);
      expect(EFFORT_INFO[e].hint).toMatch(/\.$/);
    }
    // Not every model has the top two levels; their hints say so.
    for (const e of ['xhigh', 'max'] as const) expect(EFFORT_INFO[e].hint).toContain('on models that have it');
  });

  it('adds nothing to the model chip for the default, and the level otherwise', () => {
    expect(effortSuffix('')).toBe('');
    expect(effortSuffix(undefined)).toBe('');
    expect(effortSuffix('high')).toBe(' · High');
    // The short label: the chip stays narrow.
    expect(effortSuffix('xhigh')).toBe(' · XHigh');
    expect(effortSuffix('medium')).toBe(' · Med');
    // Something a newer daemon knows and this page doesn't: left out rather than shown raw.
    expect(effortSuffix('ultra')).toBe('');
    expect(effortSuffix('toString')).toBe('');
    for (const e of Effort.options) expect(effortSuffix(e)).not.toBe('');
  });

  it('sends null to put the default back', () => {
    expect(effortPatch('')).toEqual({ effort: null });
    expect(effortPatch('max')).toEqual({ effort: 'max' });
  });
});

describe('efforts this page does not know', () => {
  it('read as the default rather than breaking the chip, the picker or the agent pane', () => {
    expect(effortOf('ultra')).toBe('');
    expect(effortOf('constructor')).toBe('');
    expect(effortOf(null)).toBe('');
    expect(effortOf('xhigh')).toBe('xhigh');
    expect(effortLabel('ultra')).toBeUndefined();
    expect(effortLabel(undefined)).toBeUndefined();
    expect(effortLabel('xhigh')).toBe('Extra high');
  });
});
