import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { saveSettingsOptions, SETTINGS, type Settings } from '@/lib/settings';

/** The person's settings; the daemon's event stream (see use-round-ups) keeps them current. */
export function useSettings() {
  return useQuery({ queryKey: SETTINGS, queryFn: () => api<Settings>('GET', '/api/settings') });
}

/** The agent limit as the daemon has it now, once known: for "3 of 6 working". */
export const useMaxAgents = () => useSettings().data?.maxAgents;

/** Saves a change at once, shown before the daemon answers and put back if it refuses (see `saveSettingsOptions`). */
export function useSaveSettings() {
  return useMutation(saveSettingsOptions(useQueryClient()));
}
