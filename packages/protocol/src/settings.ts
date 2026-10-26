import { z } from 'zod';

/**
 * The person's settings, as `GET /api/settings` returns them and `/api/events` streams them
 * (`settings`). Saved in the daemon's database; `PUT /api/settings` changes any of them.
 */

/**
 * How many of a round-up's agents may work at once. Each one is a whole harness process (and a
 * writer has its own worktree, with its own install and builds), all on the person's one
 * subscription: past 16 the machine and the usage window give out before the work goes faster.
 * The worktree limit (KELPIE_MAX_WORKTREES, 20) is shared by every round-up, so writers past it
 * are refused for that instead, whatever this allows; read-only agents need no worktree.
 */
export const MAX_AGENTS = { min: 1, max: 16, default: 4 } as const;

export const MaxAgents = z
  .number({ error: 'maxAgents must be a whole number' })
  .int({ error: 'maxAgents must be a whole number' })
  .min(MAX_AGENTS.min, { error: `maxAgents must be at least ${MAX_AGENTS.min}` })
  .max(MAX_AGENTS.max, { error: `maxAgents can be at most ${MAX_AGENTS.max}` });

export const AutoResume = z.boolean({ error: 'autoResume must be true or false' });

export const Settings = z.object({
  /** Agents one round-up may have working at once. */
  maxAgents: MaxAgents,
  /** Resume work that stopped at the usage limit once the limit resets. */
  autoResume: AutoResume,
});
export type Settings = z.infer<typeof Settings>;

/** What `PUT /api/settings` takes: only the fields given change, and null puts a setting's default back. */
export const SettingsPatch = z.object({ maxAgents: MaxAgents.nullable(), autoResume: AutoResume.nullable() }).partial().strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/**
 * What `GET` and `PUT /api/settings` answer: the settings, and each one's range with the default
 * a reset puts back (Kelpie's own, or KELPIE_MAX_AGENTS).
 */
export interface SettingsWithLimits extends Settings {
  limits: { maxAgents: { min: number; max: number; default: number } };
}

/** Settings' defaults, for a setting never saved. */
export const DEFAULT_SETTINGS: Settings = { maxAgents: MAX_AGENTS.default, autoResume: true };

/** A number clamped into the agent limit's range, rounded down; the default for anything else. */
export const clampMaxAgents = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(MAX_AGENTS.max, Math.max(MAX_AGENTS.min, Math.floor(n))) : MAX_AGENTS.default;
