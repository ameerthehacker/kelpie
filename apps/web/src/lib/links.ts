/** Where a link in rendered markdown goes: a Kelpie route, another site, or nowhere it may go. */
export type LinkTarget = { kind: 'internal'; to: string } | { kind: 'external'; href: string } | { kind: 'none' };

/** The only schemes a link may leave Kelpie for. */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Sorts a markdown link against the page it is on (`base`, the current URL): same-origin paths are
 * Kelpie routes, except the daemon's `/api`, which the router doesn't serve; `http`, `https` and
 * `mailto` open outside; anything else (`javascript:`, `data:`, Streamdown's placeholder for a link
 * still streaming in) is not a link.
 */
export function linkTarget(href: string | undefined, base: string): LinkTarget {
  if (!href) return { kind: 'none' };
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return { kind: 'none' };
  }
  if (!SAFE_PROTOCOLS.has(url.protocol)) return { kind: 'none' };
  if (url.origin === new URL(base).origin && !/^\/api(\/|$)/.test(url.pathname)) return { kind: 'internal', to: url.pathname + url.search + url.hash };
  return { kind: 'external', href: url.href };
}
