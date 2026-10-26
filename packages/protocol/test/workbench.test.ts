import { describe, expect, it } from 'vitest';
import { CardArchive, CardCreate, CardPatch, CardUpdate, workbenchPath } from '../src/index.js';

describe('CardPatch', () => {
  it('accepts a typical patch', () => {
    const patch = {
      title: 'Workbench board',
      stage: 'blocked',
      callout: 'Two agents need approval',
      tickets: [{ key: 'KEL-12', system: 'linear', url: 'https://linear.app/kelpie/issue/KEL-12' }],
      items: [
        { key: 'agent-1', status: 'review' },
        { key: 'docs-pr', title: 'Docs', ref: '#412', url: null },
        { key: 'old', remove: true },
      ],
    };
    expect(CardPatch.parse(patch)).toEqual(patch);
    expect(CardPatch.parse({ callout: null })).toEqual({ callout: null });
  });

  it('rejects a bad stage, item status or url', () => {
    expect(CardPatch.safeParse({ stage: 'shipped' }).success).toBe(false);
    expect(CardPatch.safeParse({ items: [{ key: 'a', status: 'done' }] }).success).toBe(false);
    expect(CardPatch.safeParse({ tickets: [{ key: 'X-1', system: 'jira', url: 'not a url' }] }).success).toBe(false);
  });
});

describe('CardCreate and CardUpdate', () => {
  it('requires a title to create, and a card id to update', () => {
    expect(CardCreate.safeParse({ stage: 'building' }).success).toBe(false);
    expect(CardCreate.parse({ title: 'Workbench board', stage: 'building' })).toEqual({ title: 'Workbench board', stage: 'building' });
    expect(CardUpdate.safeParse({ stage: 'review' }).success).toBe(false);
    expect(CardUpdate.parse({ card: 'c1', stage: 'review' })).toEqual({ card: 'c1', stage: 'review' });
    expect(CardUpdate.safeParse({ card: 'c1', stage: 'shipped' }).success).toBe(false);
  });
});

describe('CardArchive', () => {
  it('takes only a boolean', () => {
    expect(CardArchive.parse({ archived: true })).toEqual({ archived: true });
    expect(CardArchive.safeParse({ archived: 'yes' }).success).toBe(false);
  });
});

describe('workbenchPath', () => {
  it('links the board, or one card on it', () => {
    expect(workbenchPath()).toBe('/workbench');
    expect(workbenchPath('c1')).toBe('/workbench/c1');
    expect(workbenchPath('a/b')).toBe('/workbench/a%2Fb');
  });
});
