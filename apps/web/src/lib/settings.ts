import type { EventSourceMessage } from '@microsoft/fetch-event-source';
import type { MutationOptions, QueryClient } from '@tanstack/react-query';
import { MAX_AGENTS, MaxAgents, type Settings, type SettingsPatch, type SettingsWithLimits } from '@kelpie/protocol';
import { api } from './api.js';

export { MAX_AGENTS, type Settings, type SettingsPatch, type SettingsWithLimits };

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
      if (before && 'maxAgents' in patch) queryClient.setQueryData<SettingsWithLimits>(SETTINGS, { ...before, maxAgents: patch.maxAgents ?? defaultAgents(before) });
      return { before };
    },
    onError: (_err, _patch, context) => {
      if (context?.before) queryClient.setQueryData(SETTINGS, context.before);
    },
    onSuccess: (saved) => {
      if (queryClient.isMutating({ mutationKey: SETTINGS }) <= 1) queryClient.setQueryData(SETTINGS, saved);
    },
    onSettled: () => {
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
