import { describe, expect, it } from 'vitest';
import { parsePatchFiles } from '@pierre/diffs';
import {
  anchorFor,
  annotationsFor,
  authorLabel,
  canSubmit,
  followDraft,
  lineTextAt,
  reviewCounts,
  splitOutdated,
  threadsOffDiff,
  threadsOn,
  withThread,
  type ReviewComment,
  type ReviewState,
  type ReviewThread,
} from '../src/lib/review.js';

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: 'c',
  threadId: 't',
  author: 'person',
  body: 'why?',
  state: 'published',
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: 't',
  view: 'feature',
  path: 'billing-api/package.json',
  side: 'additions',
  line: 6,
  currentLine: 6,
  outdated: false,
  commitSha: 'h',
  lineText: '"node": ">=22"',
  diffHunk: '@@ -4,5 +4,5 @@',
  status: 'open',
  comments: [comment()],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const PATCH = `diff --git a/billing-api/package.json b/billing-api/package.json
index 1111111..2222222 100644
--- a/billing-api/package.json
+++ b/billing-api/package.json
@@ -4,4 +4,4 @@
   "private": true,
   "engines": {
-    "node": ">=20"
+    "node": ">=22"
   },
`;

describe('annotationsFor', () => {
  it('puts a thread where its line is now, and threads on one line together', () => {
    const threads = [thread({ id: 'a', line: 6, currentLine: 8 }), thread({ id: 'b', line: 8, currentLine: undefined }), thread({ id: 'c', side: 'deletions', line: 6, currentLine: 6 })];
    expect(annotationsFor(threads, 'billing-api/package.json')).toEqual([
      { side: 'deletions', lineNumber: 6, metadata: { threadIds: ['c'], draft: false } },
      { side: 'additions', lineNumber: 8, metadata: { threadIds: ['a', 'b'], draft: false } },
    ]);
  });

  it('leaves out other files and outdated threads, and adds the comment box being written', () => {
    const threads = [thread({ id: 'a', path: 'other' }), thread({ id: 'b', outdated: true, currentLine: undefined })];
    expect(annotationsFor(threads, 'billing-api/package.json', { side: 'additions', line: 5 })).toEqual([
      { side: 'additions', lineNumber: 5, metadata: { threadIds: [], draft: true } },
    ]);
  });
});

describe('splitOutdated', () => {
  const hunks = [{ additionStart: 4, additionCount: 4, deletionStart: 4, deletionCount: 4 }];
  const file = { path: 'billing-api/package.json' };

  it('keeps threads on a shown line inline and puts the rest above the diff', () => {
    const inline = thread({ id: 'in' });
    const outdated = thread({ id: 'old', outdated: true, currentLine: undefined });
    const offHunk = thread({ id: 'off', line: 40, currentLine: 40 });
    const deletion = thread({ id: 'del', side: 'deletions', line: 9, currentLine: 9 });
    const elsewhere = thread({ id: 'x', path: 'README.md' });
    const split = splitOutdated([inline, outdated, offHunk, deletion, elsewhere], file, hunks);
    expect(split.inline.map((t) => t.id)).toEqual(['in']);
    expect(split.above.map((t) => t.id)).toEqual(['old', 'off', 'del']);
  });

  it('puts every thread above a diff with no hunks to show', () => {
    expect(splitOutdated([thread()], file, undefined)).toEqual({ inline: [], above: [thread()] });
  });
});

describe('threads by view and file', () => {
  it('tells the feature diff’s threads from each agent’s', () => {
    const threads = [thread({ id: 'f' }), thread({ id: 'a1', view: 'agent', viewSessionId: 'a1' }), thread({ id: 'a2', view: 'agent', viewSessionId: 'a2' })];
    expect(threadsOn(threads, 'feature').map((t) => t.id)).toEqual(['f']);
    expect(threadsOn(threads, 'agent', 'a2').map((t) => t.id)).toEqual(['a2']);
  });

  it('finds threads on files no longer in the diff', () => {
    expect(threadsOffDiff([thread({ id: 'a' }), thread({ id: 'b', path: 'gone.ts' })], [{ path: 'billing-api/package.json' }]).map((t) => t.id)).toEqual(['b']);
  });
});

describe('reviewCounts and canSubmit', () => {
  it('counts open and resolved threads and the comments not yet submitted', () => {
    const threads = [
      thread({ status: 'open' }),
      thread({ status: 'resolved' }),
      thread({ status: 'pending', comments: [comment({ state: 'pending' })] }),
      thread({ status: 'open', comments: [comment(), comment({ state: 'pending' })] }),
    ];
    expect(reviewCounts(threads)).toEqual({ open: 2, resolved: 1, pending: 2 });
  });

  it('needs a comment or a summary for anything but an approval', () => {
    expect(canSubmit('approve', 0, '')).toBe(true);
    expect(canSubmit('comment', 0, '  ')).toBe(false);
    expect(canSubmit('request_changes', 0, '')).toBe(false);
    expect(canSubmit('request_changes', 1, '')).toBe(true);
    expect(canSubmit('comment', 0, 'Looks fine')).toBe(true);
  });
});

describe('withThread', () => {
  const state: ReviewState = { roundUpId: 'r', pending: null, reviews: [], threads: [thread({ id: 'a' })], counts: { open: 1, resolved: 0, pending: 0 } };

  it('adds a new thread, or replaces it, and recounts', () => {
    const added = withThread(state, thread({ id: 'b', status: 'pending', comments: [comment({ state: 'pending' })] }), {
      id: 'rv',
      state: 'pending',
      body: '',
      createdAt: 0,
      commentIds: [],
    })!;
    expect(added.threads.map((t) => t.id)).toEqual(['a', 'b']);
    expect(added.counts).toEqual({ open: 1, resolved: 0, pending: 1 });
    expect(added.pending?.id).toBe('rv');
    const resolved = withThread(added, thread({ id: 'a', status: 'resolved' }))!;
    expect(resolved.threads.map((t) => [t.id, t.status])).toEqual([
      ['a', 'resolved'],
      ['b', 'pending'],
    ]);
    expect(resolved.counts.resolved).toBe(1);
  });

  it('leaves a state not loaded yet alone', () => {
    expect(withThread(undefined, thread())).toBeUndefined();
  });
});

describe('authorLabel', () => {
  it('names the person, Kelpie, and agents by title', () => {
    expect(authorLabel({ author: 'person' })).toBe('You');
    expect(authorLabel({ author: 'orchestrator' })).toBe('Kelpie');
    expect(authorLabel({ author: 'agent', authorTitle: 'gateway-web' })).toBe('gateway-web');
  });
});

describe('lineTextAt', () => {
  const diff = parsePatchFiles(PATCH)[0]!.files[0]!;

  it('reads a line of either side from a parsed patch, without its newline', () => {
    expect(lineTextAt(diff, 'additions', 6)).toBe('    "node": ">=22"');
    expect(lineTextAt(diff, 'deletions', 6)).toBe('    "node": ">=20"');
    expect(lineTextAt(diff, 'additions', 4)).toBe('  "private": true,');
    expect(lineTextAt(diff, 'additions', 7)).toBe('  },');
  });

  it('knows nothing of lines no hunk shows', () => {
    expect(lineTextAt(diff, 'additions', 2)).toBeUndefined();
    expect(lineTextAt(diff, 'deletions', 8)).toBeUndefined();
  });
});

describe('anchorFor', () => {
  const at = { path: 'gateway-web/package.json', side: 'additions' as const, line: 6, lineText: '"node": ">=22"' };

  it('pins a feature-diff line at the diff’s head', () => {
    expect(anchorFor({ roundUpId: 'r', view: 'feature', commitSha: 'h1', viewSessionId: 'ignored' }, at)).toEqual({
      view: 'feature',
      path: 'gateway-web/package.json',
      side: 'additions',
      line: 6,
      commitSha: 'h1',
      lineText: '"node": ">=22"',
    });
  });

  it('names the agent for a line in an agent’s diff, at the commit it was read at', () => {
    expect(anchorFor({ roundUpId: 'r', view: 'agent', viewSessionId: 'a1', commitSha: 'g1' }, at)).toEqual({ ...at, view: 'agent', viewSessionId: 'a1', commitSha: 'g1' });
  });
});

describe('followDraft', () => {
  const diffOf = (body: string) =>
    parsePatchFiles(`diff --git a/a.js b/a.js\nindex 1111111..2222222 100644\n--- a/a.js\n+++ b/a.js\n${body}`)[0]!.files[0]!;
  // Before: line 3 added. After a re-muster, a header was added above it, so it is line 4.
  const before = diffOf('@@ -1,3 +1,4 @@\n one\n two\n+three\n four\n');
  const shifted = diffOf('@@ -1,3 +1,5 @@\n+// header\n one\n two\n+three\n four\n');
  const rewritten = diffOf('@@ -1,3 +1,4 @@\n one\n two\n+THREE\n four\n');
  const twice = diffOf('@@ -1,3 +1,5 @@\n one\n+three\n two\n+three\n four\n');
  const draft = { side: 'additions' as const, line: 3, text: 'three', body: 'kept' };

  it('stays on its line while that line still says the same', () => {
    expect(followDraft(draft, before)).toEqual({ draft, moved: false });
  });

  it('follows its text to the one line now saying it, keeping what was written', () => {
    expect(followDraft(draft, shifted)).toEqual({ draft: { ...draft, line: 4 }, moved: true });
  });

  it('lets go when the line is gone or could be either of two', () => {
    expect(followDraft(draft, rewritten)).toBeUndefined();
    expect(followDraft(draft, twice)).toBeUndefined();
    expect(followDraft({ ...draft, text: '' }, rewritten)).toBeUndefined();
  });

  it('follows a removed line on the old side', () => {
    const removed = diffOf('@@ -1,3 +1,2 @@\n one\n-two\n four\n');
    const later = diffOf('@@ -1,4 +1,3 @@\n+zero\n one\n-two\n four\n');
    expect(followDraft({ side: 'deletions', line: 2, text: 'two' }, removed)?.moved).toBe(false);
    expect(followDraft({ side: 'deletions', line: 2, text: 'two' }, later)).toEqual({ draft: { side: 'deletions', line: 2, text: 'two' }, moved: false });
  });
});
