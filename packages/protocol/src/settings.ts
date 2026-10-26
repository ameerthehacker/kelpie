import { z } from 'zod';

/**
 * The person's settings, as `GET /api/settings` returns them and `/api/events` streams them
 * (`settings`). Saved in the daemon's database; `PUT /api/settings` changes any of them.
 */

/**
 * How many of a round-up's agents may work at once. Each one is a whole harness process (and a
 * writer has its own worktree, with its own install and builds), all on the person's one
 * subscription: past 16 the machine and the usage window give out before the work goes faster,
 * and 16 writers still leave room under the worktree limit (20) for the feature branch's own.
 */
export const MAX_AGENTS = { min: 1, max: 16, default: 4 } as const;

export const MaxAgents = z
  .number({ error: 'maxAgents must be a whole number' })
  .int({ error: 'maxAgents must be a whole number' })
  .min(MAX_AGENTS.min, { error: `maxAgents must be at least ${MAX_AGENTS.min}` })
  .max(MAX_AGENTS.max, { error: `maxAgents can be at most ${MAX_AGENTS.max}` });

export const Settings = z.object({
  /** Agents one round-up may have working at once. */
  maxAgents: MaxAgents,
});
export type Settings = z.infer<typeof Settings>;

/** What `PUT /api/settings` takes: only the fields given change. */
export const SettingsPatch = Settings.partial().strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** Settings' defaults, for a setting never saved. */
export const DEFAULT_SETTINGS: Settings = { maxAgents: MAX_AGENTS.default };

/** A number clamped into the agent limit's range, rounded down; the default for anything else. */
export const clampMaxAgents = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(MAX_AGENTS.max, Math.max(MAX_AGENTS.min, Math.floor(n))) : MAX_AGENTS.default;
