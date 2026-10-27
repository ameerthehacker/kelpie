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
  max: { short: 'Max', label: 'Max', hint: 'The most thinking, on models that have it. Slowest; uses the most of your limit.' },
};

/** An effort as the daemon reports it, if this page knows it; anything else (a newer daemon's level) reads as the default. */
export const effortOf = (effort: string | null | undefined): '' | Effort => (effort && Object.hasOwn(EFFORT_INFO, effort) ? (effort as Effort) : '');

/** An effort's name ("Extra high"), or undefined for the default and for levels this page doesn't know. */
export const effortLabel = (effort: string | null | undefined): string | undefined => {
  const e = effortOf(effort);
  return e ? EFFORT_INFO[e].label : undefined;
};

/** What the model chip adds for an effort: nothing for the default, so the chip stays as it was. */
export const effortSuffix = (effort: string | null | undefined): string => {
  const e = effortOf(effort);
  return e ? ` · ${EFFORT_INFO[e].short}` : '';
};

/** What a round-up's effort is set to when the person picks `next` ('' puts the default back). */
export const effortPatch = (next: '' | Effort): { effort: Effort | null } => ({ effort: next || null });
