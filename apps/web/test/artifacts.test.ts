import { describe, expect, it } from 'vitest';
import { artifactKey, type ArtifactDocument, type WorkbenchCard, type WorkbenchItem } from '@kelpie/protocol';
import { approveTurn, artifactCount, changesAccepted, askTurn, fileName, linkLabel, paneKey, prSummary, pullRequestsOf, refOfKey } from '../src/lib/artifacts.js';
import { tabOf } from '../src/hooks/use-changes-nav.js';

const NOW = new Date('2026-10-28T10:00:00').getTime();
const item = (over: Partial<WorkbenchItem>): WorkbenchItem => ({ key: 'k', title: 'Item', status: 'draft', waiting: 0, updatedAt: NOW, ...over });
const card = (over: Partial<WorkbenchCard>): WorkbenchCard => ({
  id: 'c1',
  roundUpId: 'r1',
  title: 'Guest checkout',
  chat: 'Chat',
  stage: 'building',
  tickets: [],
  items: [],
  agents: { total: 0, working: 0 },
  needsYou: 0,
  notes: [],
  noteCount: 0,
  archived: false,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const doc = (path: string): ArtifactDocument => ({ path, title: path, size: 1, updatedAt: NOW });

describe('artifact refs', () => {
  it('round-trips pane keys, and leaves agent ids alone', () => {
    for (const ref of [{ kind: 'document', path: 'notes/a.md' }, { kind: 'changes', agentId: 'a1' }] as const) expect(refOfKey(paneKey(ref))).toEqual(ref);
    expect(refOfKey('0b5c7d2e-agent-uuid')).toBeUndefined();
  });

  it('keys Accepts by path, and code changes by their commit', () => {
    expect(artifactKey({ kind: 'document', path: 'a.md' })).toBe('doc:a.md');
    expect(artifactKey({ kind: 'changes', agentId: 'a1' }, 'abc123')).toBe('changes:a1@abc123');
    expect(fileName('db/migrations/README.md')).toBe('README.md');
  });
});

describe('the Artifacts tab in the address', () => {
  it('reads ?tab=artifacts, and the conversation for no tab or one it does not know', () => {
    expect(tabOf('artifacts')).toBe('artifacts');
    expect(tabOf('changes')).toBe('changes');
    expect(tabOf(null)).toBe('conversation');
    expect(tabOf('Artifacts')).toBe('conversation');
    expect(tabOf('conversation')).toBe('conversation');
  });
});

describe('changesAccepted', () => {
  it("holds at the agent's commit now, and only there", () => {
    const accepted = { 'changes:a1@abc1234': 1 };
    expect(changesAccepted({ accepted, heads: { a1: 'abc1234' } }, 'a1')).toBe(true);
    // New commits since: ready for review again.
    expect(changesAccepted({ accepted, heads: { a1: 'def5678' } }, 'a1')).toBe(false);
    // No commit known (its branch is gone): an Accept at any commit counts.
    expect(changesAccepted({ accepted, heads: {} }, 'a1')).toBe(true);
    expect(changesAccepted({ accepted, heads: {} }, 'a2')).toBe(false);
  });
});

describe('pull requests', () => {
  const cards = [
    card({ items: [item({ key: 'm', status: 'merged', ref: '#481' }), item({ key: 'r', status: 'review', ref: '#484' })] }),
    card({
      id: 'c2',
      items: [
        item({ key: 'd', status: 'draft', updatedAt: NOW - 1, url: 'https://github.com/acme/shop/pull/490' }),
        item({ key: 'd2', status: 'draft', ref: '#491' }),
        // A writer Kelpie put on the card: no link, no ref, so no pull request.
        item({ key: 'agent-1', status: 'draft', agentId: 'agent-1', agentTitle: 'Guest form' }),
      ],
    }),
    card({ id: 'other', roundUpId: 'r2', items: [item({ key: 'x', ref: '#1' })] }),
  ];

  it("takes the round-up's cards' pull requests (items with a link or a ref), what needs the person first, then the newest", () => {
    expect(pullRequestsOf(cards, 'r1').map((p) => p.item.key)).toEqual(['r', 'd2', 'd', 'm']);
    expect(pullRequestsOf(undefined, 'r1')).toEqual([]);
  });

  it('sums up those shown, and those not in brackets', () => {
    const prs = pullRequestsOf(cards, 'r1');
    expect(prSummary(prs)).toBe('1 needs your review · 2 draft · 1 merged');
    expect(prSummary(prs, 2)).toBe('1 needs your review · 1 draft (2 more · 1 draft · 1 merged)');
  });

  it('counts documents and pull requests for the tab, and nothing when there are none', () => {
    expect(artifactCount([doc('a.md')], pullRequestsOf(cards, 'r1'))).toBe(5);
    expect(artifactCount([], [])).toBeUndefined();
    expect(artifactCount(undefined, [])).toBeUndefined();
  });

  it('names links and the turns sent for the person', () => {
    expect(linkLabel('https://github.com/acme/shop/pull/484')).toBe('Open on GitHub');
    expect(linkLabel('https://gitlab.com/acme/shop/-/merge_requests/1')).toBe('Open link');
    expect(linkLabel('not a url')).toBe('Open link');
    const [pr] = pullRequestsOf(cards, 'r1');
    expect(approveTurn(pr!)).toBe('I approve “Item” (#484) on “Guest checkout”. Move it on.');
    expect(askTurn({ kind: 'document', file: '/s/notes.md' }, 'Shorter, please')).toBe('About your document /s/notes.md: Shorter, please');
    expect(askTurn({ kind: 'changes' }, 'Rename it')).toBe('About your code changes: Rename it');
  });
});
