import { isAppPath } from './routes.js';

/** Where a link in rendered markdown goes: a Kelpie page, another site, an email, or nowhere it may go. */
export type LinkTarget = { kind: 'internal'; to: string } | { kind: 'external'; href: string } | { kind: 'mail'; href: string } | { kind: 'none' };

const WEB_PROTOCOLS = new Set(['http:', 'https:']);
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/**
 * Sorts a markdown link against the page it is on (`base`, the current URL). Kelpie pages, given
 * as `/path`, `#anchor` or a full same-origin URL, navigate in-app; `http`, `https` and `mailto`
 * leave Kelpie. Everything else is not a link: other schemes (`javascript:`, `data:`, Streamdown's
 * placeholder for a link still streaming in), same-origin paths the app has no page for, and bare
 * relative paths like `src/foo.ts`, which agents mean as files in the repo, not pages.
 */
export function linkTarget(href: string | undefined, base: string): LinkTarget {
  const raw = href?.trim();
  if (!raw) return { kind: 'none' };
  if (!SCHEME.test(raw) && !raw.startsWith('/') && !raw.startsWith('#')) return { kind: 'none' };
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return { kind: 'none' };
  }
  if (url.protocol === 'mailto:') return { kind: 'mail', href: url.href };
  if (!WEB_PROTOCOLS.has(url.protocol)) return { kind: 'none' };
  if (url.origin !== new URL(base).origin) return { kind: 'external', href: url.href };
  return isAppPath(url.pathname) ? { kind: 'internal', to: url.pathname + url.search + url.hash } : { kind: 'none' };
}
