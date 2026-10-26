import { describe, expect, it } from 'vitest';
import { CardArchive, CardCreate, CardPatch, CardUpdate, EntryPatch, NotePost, workbenchPath } from '../src/index.js';

describe('CardPatch', () => {
  it('accepts a typical patch', () => {
    const patch = {
      title: 'Workbench board',
      stage: 'blocked',
      callout: 'Two agents need approval',
      tickets: [{ provider: 'jira', kind: 'issue', key: 'KEL-12', url: 'https://kelpie.atlassian.net/browse/KEL-12' }],
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
    expect(CardPatch.safeParse({ tickets: [{ provider: 'jira', kind: 'issue', key: 'X-1', url: 'not a url' }] }).success).toBe(false);
  });

  it('takes tickets as linked tickets, without how a round-up linked them', () => {
    const asana = { provider: 'asana', kind: 'project', url: 'https://app.asana.com/0/1201/list', title: 'Q4 checkout launch' };
    expect(CardPatch.parse({ tickets: [asana] })).toEqual({ tickets: [asana] });
    // A round-up's own record of the link is not the card's to keep.
    expect(CardPatch.parse({ tickets: [{ ...asana, source: 'orchestrator', addedAt: 1 }] })).toEqual({ tickets: [asana] });
    expect(CardPatch.safeParse({ tickets: [{ provider: 'linear', kind: 'issue', key: 'KEL-12', url: 'https://linear.app/kelpie/issue/KEL-12' }] }).success).toBe(false);
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

describe('EntryPatch and NotePost', () => {
  it('takes only the fields given, null to clear, and trims claims', () => {
    expect(EntryPatch.parse({ focus: 'Checkout API', claims: [' packages/api/** '], blocker: null })).toEqual({ focus: 'Checkout API', claims: ['packages/api/**'], blocker: null });
    expect(EntryPatch.parse({})).toEqual({});
    expect(EntryPatch.safeParse({ claims: [''] }).success).toBe(false);
    expect(EntryPatch.safeParse({ claims: Array.from({ length: 31 }, (_, i) => `f${i}`) }).success).toBe(false);
  });

  it('needs a note with some text', () => {
    expect(NotePost.parse({ body: '  Please hold off on api/  ', to: 'agent-1' })).toEqual({ body: 'Please hold off on api/', to: 'agent-1' });
    expect(NotePost.safeParse({ body: '   ' }).success).toBe(false);
  });
});
