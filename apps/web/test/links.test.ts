import { describe, expect, it } from 'vitest';
import { linkTarget } from '../src/lib/links.js';
import { isAppPath } from '../src/lib/routes.js';

const here = 'http://localhost:7317/r/abc';

describe('linkTarget', () => {
  it('opens other sites outside, and mail in the mail app', () => {
    expect(linkTarget('https://github.com/o/r/pull/1', here)).toEqual({ kind: 'external', href: 'https://github.com/o/r/pull/1' });
    expect(linkTarget('http://example.com', here)).toEqual({ kind: 'external', href: 'http://example.com/' });
    expect(linkTarget('//evil.com/x', here)).toEqual({ kind: 'external', href: 'http://evil.com/x' });
    expect(linkTarget('http://localhost:5173/r/xyz', here).kind).toBe('external');
    expect(linkTarget('mailto:a@b.c', here)).toEqual({ kind: 'mail', href: 'mailto:a@b.c' });
  });

  it('keeps Kelpie pages in-app', () => {
    expect(linkTarget('/workbench', here)).toEqual({ kind: 'internal', to: '/workbench' });
    expect(linkTarget('/workbench/card-1', here)).toEqual({ kind: 'internal', to: '/workbench/card-1' });
    expect(linkTarget('http://localhost:7317/r/xyz?tab=changes#a', here)).toEqual({ kind: 'internal', to: '/r/xyz?tab=changes#a' });
    expect(linkTarget('#anchor', here)).toEqual({ kind: 'internal', to: '/r/abc#anchor' });
  });

  it('leaves relative paths and pages the app lacks as text', () => {
    for (const href of ['src/foo.ts', './README.md', '../x', '/foo', '/r/abc/src/foo.ts', '/api/uploads/x.png', 'http://localhost:7317/foo'])
      expect(linkTarget(href, here), href).toEqual({ kind: 'none' });
  });

  it('drops unsafe and unfinished links', () => {
    for (const href of [undefined, '', '  ', 'javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,hi', 'vbscript:x', 'file:///etc/passwd', 'tel:123', 'streamdown:incomplete-link'])
      expect(linkTarget(href, here), String(href)).toEqual({ kind: 'none' });
  });
});

describe('isAppPath', () => {
  it('knows the pages main.tsx mounts', () => {
    expect(['/', '/r/abc', '/approvals', '/workbench', '/workbench/c1', '/settings'].every(isAppPath)).toBe(true);
    expect(['/foo', '/r', '/r/a/b', '/api/sessions'].some(isAppPath)).toBe(false);
  });
});
