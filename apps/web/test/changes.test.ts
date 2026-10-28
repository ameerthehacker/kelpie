import { describe, expect, it } from 'vitest';
import { agentsOf, anchorSha, filesLabel, groupByDir, musteredFromLabel, gutterNumbers, neighbors, splitPath, statSquares, vscodeUrl } from '../src/lib/changes.js';

describe('splitPath', () => {
  it('splits a path into its directory and its name', () => {
    expect(splitPath('billing-api/src/index.ts')).toEqual({ dir: 'billing-api/src/', base: 'index.ts' });
    expect(splitPath('Dockerfile')).toEqual({ dir: '', base: 'Dockerfile' });
  });
});

describe('groupByDir', () => {
  it('groups files by directory, in the order directories first appear', () => {
    const files = [{ path: 'b/x.ts' }, { path: 'a/y.ts' }, { path: 'b/z.ts' }, { path: 'README.md' }];
    expect(groupByDir(files)).toEqual([
      { dir: 'b/', files: [{ path: 'b/x.ts' }, { path: 'b/z.ts' }] },
      { dir: 'a/', files: [{ path: 'a/y.ts' }] },
      { dir: '', files: [{ path: 'README.md' }] },
    ]);
  });
});

describe('neighbors', () => {
  const files = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];

  it('finds a file and the ones either side of it', () => {
    expect(neighbors(files, 'b')).toEqual({ index: 1, total: 3, current: { path: 'b' }, prev: { path: 'a' }, next: { path: 'c' } });
    expect(neighbors(files, 'a')).toMatchObject({ index: 0, prev: undefined, next: { path: 'b' } });
    expect(neighbors(files, 'c')).toMatchObject({ index: 2, prev: { path: 'b' }, next: undefined });
  });

  it('says so when the file is not in the list', () => {
    expect(neighbors(files, 'z')).toEqual({ index: -1, total: 3 });
    expect(neighbors(files, undefined)).toEqual({ index: -1, total: 3 });
  });
});

describe('statSquares', () => {
  it('splits five squares in proportion', () => {
    expect(statSquares(1, 1)).toEqual(['add', 'add', 'add', 'del', 'del']);
    expect(statSquares(10, 0)).toEqual(['add', 'add', 'add', 'add', 'add']);
    expect(statSquares(0, 3)).toEqual(['del', 'del', 'del', 'del', 'del']);
    expect(statSquares(30, 10)).toEqual(['add', 'add', 'add', 'add', 'del']);
  });

  it('gives a side with any lines at least one square', () => {
    expect(statSquares(100, 1)).toEqual(['add', 'add', 'add', 'add', 'del']);
    expect(statSquares(1, 100)).toEqual(['add', 'del', 'del', 'del', 'del']);
  });

  it('leaves a file with no line changes blank', () => {
    expect(statSquares(0, 0)).toEqual(['none', 'none', 'none', 'none', 'none']);
  });
});

describe('small labels', () => {
  it('counts files', () => {
    expect(filesLabel(1)).toBe('1 file');
    expect(filesLabel(185)).toBe('185 files');
  });

  it('says how many agents a feature branch was mustered from', () => {
    expect(musteredFromLabel(1)).toBe("Mustered from 1 agent's branch");
    expect(musteredFromLabel(2)).toBe("Mustered from 2 agents' branches");
  });

  it('lists each agent once', () => {
    const api = { id: 'a1', title: 'API', harness: 'claude-code' };
    const base = { id: null, title: 'Muster', harness: 'claude-code' };
    expect(agentsOf([{ agents: [api] }, { agents: [api, base] }])).toEqual([api, base]);
  });

  it('opens a file in VS Code only when the branch is checked out', () => {
    expect(vscodeUrl('/Users/me/wt/abc/', 'src/a.ts')).toBe('vscode://file/Users/me/wt/abc/src/a.ts');
    expect(vscodeUrl(undefined, 'src/a.ts')).toBeUndefined();
    // The checkout itself, and a path with spaces, # and ? in it.
    expect(vscodeUrl('/Users/me/wt/abc')).toBe('vscode://file/Users/me/wt/abc');
    expect(vscodeUrl('/Users/me/My Notes', 'a #1?.md')).toBe('vscode://file/Users/me/My%20Notes/a%20%231%3F.md');
  });
});

describe('anchorSha', () => {
  const rounds = [
    { index: 1, state: 'mustered' as const, baseSha: 'f0', headSha: 'g1' },
    { index: 2, state: 'active' as const, baseSha: 'f1', headSha: 'g2-at-pick' },
  ];
  it('is the picked round’s head, or the diff’s head for the active or default round', () => {
    expect(anchorSha({ headSha: 'h', rounds }, 1)).toBe('g1');
    expect(anchorSha({ headSha: 'h', rounds }, 2)).toBe('h');
    expect(anchorSha({ headSha: 'h', rounds })).toBe('h');
    expect(anchorSha({ headSha: 'h' })).toBe('h');
    expect(anchorSha(undefined, 1)).toBeUndefined();
  });
});

describe('gutterNumbers', () => {
  it('puts old and new line numbers side by side, a column each', () => {
    // A context line: data-line is its new number, data-alt-line its old one.
    expect(gutterNumbers('context', 11, 7, 2)).toBe(' 7 11');
    expect(gutterNumbers('change-deletion', 7, undefined, 2)).toBe(' 7   ');
    expect(gutterNumbers('change-addition', 11, undefined, 2)).toBe('   11');
    expect(gutterNumbers('context', 3, undefined, 1)).toBe('3 3');
  });
});
