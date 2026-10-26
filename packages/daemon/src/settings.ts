import { clampMaxAgents, DEFAULT_SETTINGS, MAX_AGENTS, Settings, SettingsPatch, type SettingsWithLimits } from '@kelpie/protocol';
import type { Store } from '@kelpie/store';

/** A change `PUT /api/settings` refuses: the message says what is wrong. */
export class SettingsError extends Error {}

/**
 * The person's settings, saved in the store. A setting never saved has its default: Kelpie's own,
 * or one Kelpie was started with (KELPIE_MAX_AGENTS), clamped into its range.
 */
export class SavedSettings {
  /** What a setting is when none is saved, and what a reset puts back. */
  readonly defaults: Settings;
  private current: Settings;
  private readonly listeners = new Set<(next: Settings, prev: Settings) => void>();

  constructor(
    private readonly store: Store,
    defaults: { maxAgents?: number | undefined } = {},
  ) {
    this.defaults = { ...DEFAULT_SETTINGS, ...(defaults.maxAgents !== undefined ? { maxAgents: clampMaxAgents(defaults.maxAgents) } : {}) };
    this.current = this.read();
  }

  get(): Settings {
    return this.current;
  }

  /** Validates and saves a change (only the fields given; null puts a default back), then tells every listener. */
  update(patch: unknown): Settings {
    const parsed = SettingsPatch.safeParse(patch);
    if (!parsed.success) throw new SettingsError(parsed.error.issues.map((i) => (i.code === 'unrecognized_keys' ? `unknown setting: ${i.keys.join(', ')}` : i.message)).join('; '));
    if (!Object.keys(parsed.data).length) throw new SettingsError('nothing to change: send maxAgents');
    const prev = this.current;
    this.store.setSettings(parsed.data);
    const next = { ...prev };
    for (const [key, v] of Object.entries(parsed.data) as [keyof Settings, number | null][]) next[key] = v ?? this.defaults[key];
    this.current = next;
    for (const listener of this.listeners) {
      try {
        listener(this.current, prev);
      } catch (err) {
        console.error('settings listener failed', err);
      }
    }
    return this.current;
  }

  /** The settings with each one's range and the default a reset puts back, as the API answers. */
  withLimits(): SettingsWithLimits {
    return { ...this.current, limits: { maxAgents: { min: MAX_AGENTS.min, max: MAX_AGENTS.max, default: this.defaults.maxAgents } } };
  }

  /** Called after every change, with the settings before it. Returns the unsubscribe. */
  onChange(listener: (next: Settings, prev: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** What is saved, over the defaults; a saved value that no longer passes (an older range) falls back to its default. */
  private read(): Settings {
    const saved = this.store.settings();
    const out = { ...this.defaults };
    for (const key of Object.keys(Settings.shape) as (keyof Settings)[]) {
      const v = Settings.shape[key].safeParse(saved[key]);
      if (v.success) out[key] = v.data;
    }
    return out;
  }
}
