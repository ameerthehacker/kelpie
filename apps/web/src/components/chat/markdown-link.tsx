import { ArrowUpRightIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Link } from 'react-router';
import type { Components, ExtraProps, LinkSafetyConfig } from 'streamdown';
import { linkTarget } from '@/lib/links';
import { cn } from '@/lib/utils';

const linkClass =
  'text-acc wrap-anywhere rounded-sm font-medium underline decoration-acc/30 underline-offset-2 outline-none hover:decoration-current focus-visible:ring-2 focus-visible:ring-ring/50';

/**
 * A link in rendered markdown: Kelpie routes navigate in-app, other sites open in a new tab
 * straight away, and anything unsafe stays plain text. Replaces Streamdown's own link, whose
 * link-safety prompt asked before every click.
 */
export function MarkdownLink({ href, children, className, node: _node, target: _target, rel: _rel, ...props }: ComponentProps<'a'> & ExtraProps) {
  const target = linkTarget(href, window.location.href);
  if (target.kind === 'none') return <span className={className}>{children}</span>;
  if (target.kind === 'internal')
    return (
      <Link {...props} to={target.to} className={cn(linkClass, className)}>
        {children}
      </Link>
    );
  return (
    <a {...props} href={target.href} target="_blank" rel="noopener noreferrer" className={cn(linkClass, className)}>
      {children}
      <ArrowUpRightIcon aria-hidden="true" className="ml-px inline size-3 align-[-1px] opacity-70" strokeWidth={2.2} />
    </a>
  );
}

/** For every Streamdown: our links, and none of its click-to-confirm prompt. */
export const markdownLinks: Components = { a: MarkdownLink };
export const noLinkSafety: LinkSafetyConfig = { enabled: false };
