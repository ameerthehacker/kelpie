import { describe, expect, it } from 'vitest';
import { Effort } from '@kelpie/protocol';
import { EFFORT_INFO, EFFORTS, effortPatch, effortSuffix } from '../src/lib/effort.js';

describe('the effort picker', () => {
  it('offers the default and then every level the CLI takes, lowest first, each with a label and a hint', () => {
    expect(EFFORTS).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    for (const e of EFFORTS) {
      expect(EFFORT_INFO[e].short.length).toBeLessThanOrEqual(7);
      expect(EFFORT_INFO[e].hint).toMatch(/\.$/);
    }
  });

  it('adds nothing to the model chip for the default, and the level otherwise', () => {
    expect(effortSuffix('')).toBe('');
    expect(effortSuffix(undefined)).toBe('');
    expect(effortSuffix('high')).toBe(' · High');
    expect(effortSuffix('xhigh')).toBe(' · Extra high');
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
