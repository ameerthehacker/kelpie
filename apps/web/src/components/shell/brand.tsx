import { cn } from '@/lib/utils';

/** The kelpie head mark from the design canvas, on its accent tile; follows the theme. */
export function KelpieLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={cn('shrink-0', className)}>
      <rect width="48" height="48" rx="12" className="fill-acc" />
      <g transform="translate(24 24) scale(0.74) translate(-24.5 -24.2)" className="fill-accfg stroke-accfg" strokeWidth="2" strokeLinejoin="round">
        <circle cx="19" cy="27" r="11" />
        <path d="M11 20 L15 3.5 L24 17 Z" />
        <path d="M24 19 L41 27.5 L41.5 30 L39.5 31.5 L25 36 Z" />
        <path d="M9.5 30 L7 44 L21 44 L27 34 Z" />
      </g>
      <circle cx="23.3" cy="24.6" r="1.4" className="fill-acc" />
    </svg>
  );
}

/** The wordmark: lowercase, in the display face. */
export function Wordmark({ className }: { className?: string }) {
  return <span className={cn('font-heading text-[19px] font-bold tracking-[-0.03em]', className)}>kelpie</span>;
}
