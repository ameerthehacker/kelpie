import type { EventSourceMessage } from '@microsoft/fetch-event-source';
import type { MutationOptions, QueryClient } from '@tanstack/react-query';
import {
  DEFAULT_SETTINGS,
  MAX_AGENTS,
  MaxAgents,
  type Settings as ProtocolSettings,
  type SettingsPatch as ProtocolSettingsPatch,
  type SettingsWithLimits as ProtocolSettingsWithLimits,
} from '@kelpie/protocol';
import { api } from './api.js';
import { DEFAULT_DELEGATION, type Delegation } from './delegation.js';

export { MAX_AGENTS };

// The default delegation level, until @kelpie/protocol's Settings carry it (see lib/delegation).
export type Settings = ProtocolSettings & { delegation?: Delegation };
export type SettingsPatch = ProtocolSettingsPatch & { delegation?: Delegation | null };
export type SettingsWithLimits = ProtocolSettingsWithLimits & { delegation?: Delegation };

const DEFAULTS: Required<Settings> = { ...DEFAULT_SETTINGS, delegation: DEFAULT_DELEGATION };

/** How far Page Up and Page Down move the limit. */
export const PAGE_STEP = 4;

/** Query (and mutation) key for the person's settings. */
export const SETTINGS = ['settings'] as const;

/** The stepper's next value: `delta` more (or fewer), never past the range. */
export const stepAgents = (value: number, delta: number): number => Math.min(MAX_AGENTS.max, Math.max(MAX_AGENTS.min, value + delta));

/** What the person typed, as a limit to save, or why it can't be one. */
export function parseAgents(text: string): { value: number } | { error: string } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { error: `Enter a whole number from ${MAX_AGENTS.min} to ${MAX_AGENTS.max}.` };
  const parsed = MaxAgents.safeParse(Number(trimmed));
  return parsed.success ? { value: parsed.data } : { error: `Choose from ${MAX_AGENTS.min} to ${MAX_AGENTS.max}.` };
}

/**
 * "3 of 6 working", against the person's limit; just "3 working" while the limit isn't known. The
 * count can be over the limit for a while after the person lowers it.
 */
export const workingLabel = (working: number, limit: number | undefined): string => (limit ? `${working} of ${limit} working` : `${working} working`);

/** The default a reset puts back: the daemon's (it may be KELPIE_MAX_AGENTS), or Kelpie's own until that is known. */
export const defaultAgents = (s: Partial<SettingsWithLimits> | undefined): number => s?.limits?.maxAgents.default ?? MAX_AGENTS.default;

/** The settings with a change in, as shown before the daemon answers: null is the setting's default. */
export function withPatch<S extends Partial<SettingsWithLimits>>(s: S, patch: SettingsPatch): S {
  const next: Record<string, unknown> = { ...s };
  for (const [key, v] of Object.entries(patch) as [keyof Settings, unknown][]) next[key] = v ?? (key === 'maxAgents' ? defaultAgents(s) : DEFAULTS[key]);
  return next as S;
}

/**
 * Saving settings: shown in the cache at once, put back if the daemon refuses. Saves share a scope,
 * so they go out one at a time, in order; only the last one's answer lands, or an earlier answer
 * would undo a later change still showing. Once the last one settles, the daemon is asked again:
 * a queued save's "before" is the one ahead of it, which may have failed too, and changes from
 * other tabs are not taken from the stream while a save is going out.
 */
export function saveSettingsOptions(queryClient: QueryClient): MutationOptions<SettingsWithLimits, Error, SettingsPatch, { before: SettingsWithLimits | undefined }> {
  return {
    scope: { id: 'settings' },
    mutationKey: SETTINGS,
    mutationFn: (patch) => api<SettingsWithLimits>('PUT', '/api/settings', patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: SETTINGS });
      const before = queryClient.getQueryData<SettingsWithLimits>(SETTINGS);
      if (before) queryClient.setQueryData<SettingsWithLimits>(SETTINGS, withPatch(before, patch));
      return { before };
    },
    onError: (_err, _patch, context) => {
      if (context?.before) queryClient.setQueryData(SETTINGS, context.before);
    },
    onSuccess: (saved) => {
      if (queryClient.isMutating({ mutationKey: SETTINGS }) <= 1) queryClient.setQueryData(SETTINGS, saved);
    },
    onSettled: (_saved, _err, patch) => {
      // Revoking or re-allowing an MCP server drops the rules saved for its tools, in every round-up.
      if ('mcpAllow' in patch || 'useUserMcp' in patch) void queryClient.invalidateQueries({ queryKey: ['rules'] });
      if (queryClient.isMutating({ mutationKey: SETTINGS }) <= 1) void queryClient.invalidateQueries({ queryKey: SETTINGS });
    },
  };
}

/**
 * The event stream's `settings`: on every (re)connect, then on every change, from any tab. Not over
 * a save of this tab's still going out, whose own answer settles it.
 */
export function settingsStream(queryClient: QueryClient): Record<string, (msg: EventSourceMessage) => void> {
  return {
    settings: (msg) => {
      if (queryClient.isMutating({ mutationKey: SETTINGS })) return;
      queryClient.setQueryData<Partial<SettingsWithLimits>>(SETTINGS, (prev) => ({ ...prev, ...(JSON.parse(msg.data) as Settings) }));
    },
  };
}
