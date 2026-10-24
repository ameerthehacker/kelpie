import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { liveStream } from '@/lib/live-stream';
import { byRecent, type RoundUp } from '@/lib/round-ups';
import type { HarnessUsage } from '@/lib/usage';
import { USAGE } from './use-usage';

const ROUND_UPS = ['round-ups'] as const;

/** Sub-agents are not listed in the sidebar; they belong to their orchestrator. */
const upsert = (list: RoundUp[] = [], next: RoundUp) =>
  next.parentId ? list : [next, ...list.filter((r) => r.id !== next.id)].sort(byRecent);

/**
 * The daemon's round-ups: fetched once, then kept live by its event stream; plus rename and
 * delete. The same stream keeps harness usage (use-usage) current.
 */
export function useRoundUps() {
  const queryClient = useQueryClient();
  const [streamError, setStreamError] = useState<string | undefined>();

  const list = useQuery({
    queryKey: ROUND_UPS,
    queryFn: () => api<RoundUp[]>('GET', '/api/sessions'),
    select: (rows) => [...rows].sort(byRecent),
  });
  const health = useQuery({ queryKey: ['health'], queryFn: () => api<{ defaultCwd: string }>('GET', '/api/health') });

  useEffect(
    () =>
      liveStream({
        url: () => '/api/events',
        on: {
          sessions: (msg) => queryClient.setQueryData(ROUND_UPS, JSON.parse(msg.data) as RoundUp[]),
          session: (msg) => queryClient.setQueryData<RoundUp[]>(ROUND_UPS, (rows) => upsert(rows, JSON.parse(msg.data) as RoundUp)),
          usage: (msg) => queryClient.setQueryData(USAGE, JSON.parse(msg.data) as HarnessUsage[]),
          deleted: (msg) => {
            const { id } = JSON.parse(msg.data) as { id: string };
            queryClient.setQueryData<RoundUp[]>(ROUND_UPS, (rows) => rows?.filter((r) => r.id !== id));
          },
        },
        onStatus: setStreamError,
      }),
    [queryClient],
  );

  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api<RoundUp>('PATCH', `/api/sessions/${id}`, { title }),
    onSuccess: (info) => queryClient.setQueryData<RoundUp[]>(ROUND_UPS, (rows) => upsert(rows, info)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/sessions/${id}`),
    onSuccess: (_, id) => queryClient.setQueryData<RoundUp[]>(ROUND_UPS, (rows) => rows?.filter((r) => r.id !== id)),
  });

  const actionError = rename.error
    ? `Couldn't rename the round-up: ${rename.error.message}`
    : remove.error
      ? `Couldn't delete the round-up: ${remove.error.message}`
      : undefined;

  return {
    roundUps: list.data,
    error: streamError ?? list.error?.message,
    defaultCwd: health.data?.defaultCwd,
    rename: (id: string, title: string) => rename.mutateAsync({ id, title }),
    remove: (id: string) => remove.mutateAsync(id),
    actionError,
    clearActionError: () => {
      rename.reset();
      remove.reset();
    },
  };
}
