import { Effort } from '@kelpie/protocol';

/** The efforts as the picker offers them, lowest first; '' leaves it to the harness. */
export const EFFORTS: readonly ('' | Effort)[] = ['', ...Effort.options];

/** How each effort reads: a short segment label, its name elsewhere, and a one-line hint. */
export const EFFORT_INFO: Record<'' | Effort, { short: string; label: string; hint: string }> = {
  '': { short: 'Default', label: 'Default', hint: 'Whatever your Claude Code settings or the model choose.' },
  low: { short: 'Low', label: 'Low', hint: 'Quick answers with little thinking. For simple, mechanical work.' },
  medium: { short: 'Med', label: 'Medium', hint: 'Balanced speed and depth.' },
  high: { short: 'High', label: 'High', hint: 'Thinks harder before acting. Good for tricky work.' },
  xhigh: { short: 'XHigh', label: 'Extra high', hint: 'Deeper still, on models that have it. Slower, uses more of your limit.' },
  max: { short: 'Max', label: 'Max', hint: 'As much thinking as the model allows. Slowest; uses the most of your limit.' },
};

/** What the model chip adds for an effort: nothing for the default, so the chip stays as it was. */
export const effortSuffix = (effort: string | undefined): string => (effort && Object.hasOwn(EFFORT_INFO, effort) ? ` · ${EFFORT_INFO[effort as Effort].label}` : '');

/** What a round-up's effort is set to when the person picks `next` ('' puts the default back). */
export const effortPatch = (next: '' | Effort): { effort: Effort | null } => ({ effort: next || null });
