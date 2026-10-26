import { describe, expect, it } from 'vitest';
import { linkTarget } from '../src/lib/links.js';

const here = 'http://localhost:7317/r/abc';

describe('linkTarget', () => {
  it('opens other sites and mail outside', () => {
    expect(linkTarget('https://github.com/o/r/pull/1', here)).toEqual({ kind: 'external', href: 'https://github.com/o/r/pull/1' });
    expect(linkTarget('http://example.com', here)).toEqual({ kind: 'external', href: 'http://example.com/' });
    expect(linkTarget('mailto:a@b.c', here)).toEqual({ kind: 'external', href: 'mailto:a@b.c' });
  });

  it('keeps Kelpie routes in-app, but not the daemon API', () => {
    expect(linkTarget('/workbench', here)).toEqual({ kind: 'internal', to: '/workbench' });
    expect(linkTarget('http://localhost:7317/r/xyz?tab=changes#a', here)).toEqual({ kind: 'internal', to: '/r/xyz?tab=changes#a' });
    expect(linkTarget('#top', here)).toEqual({ kind: 'internal', to: '/r/abc#top' });
    expect(linkTarget('/api/uploads/x.png', here)).toEqual({ kind: 'external', href: 'http://localhost:7317/api/uploads/x.png' });
    expect(linkTarget('http://localhost:5173/r/xyz', here).kind).toBe('external');
  });

  it('drops unsafe and unfinished links', () => {
    for (const href of [undefined, '', 'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,hi', 'vbscript:x', 'file:///etc/passwd', 'tel:123', 'streamdown:incomplete-link'])
      expect(linkTarget(href, here)).toEqual({ kind: 'none' });
  });
});
