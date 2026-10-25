import type { Mode } from '@kelpie/protocol';

/** How each mode reads in the composer. */
export const MODE_INFO: Record<Mode, { label: string; detail: string }> = {
  auto: { label: 'Auto', detail: 'Agents work without asking; the harness holds back risky actions.' },
  acceptEdits: { label: 'Accept edits', detail: 'Agents change files freely; anything else asks you first.' },
  plan: { label: 'Plan', detail: 'Nothing changes: agents only investigate, and Kelpie proposes a plan.' },
};

/** The mode after `mode` in the harness's cycle (Shift+Tab), wrapping round. */
export function nextMode(modes: readonly Mode[], mode: Mode): Mode {
  if (!modes.length) return mode;
  return modes[(modes.indexOf(mode) + 1) % modes.length]!;
}
