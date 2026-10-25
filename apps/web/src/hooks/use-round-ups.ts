import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { liveStream } from '@/lib/live-stream';
import type { AgentSummary } from '@/lib/agents';
import { byRecent, type RoundUp } from '@/lib/round-ups';
import { AGENTS, agentsKey, upsertAgent } from './use-agents';
import type { HarnessUsage } from '@/lib/usage';
import { USAGE } from './use-usage';
import { APPROVALS } from './use-approvals';
import type { PendingApproval } from '@/lib/approvals';
import { attention } from './use-attention';
import { dropSession, SUB_AGENTS, upsertSubAgent } from './use-round-up-status';
import type { CardRemoved, WorkbenchCard } from '@kelpie/protocol';
import { dropCard, upsertCard } from '@/lib/workbench';
import { WORKBENCH } from './use-workbench';

const ROUND_UPS = ['round-ups'] as const;

/** Sub-agents are not listed in the sidebar; they belong to their orchestrator. */
const upsert = (list: RoundUp[] = [], next: RoundUp) =>
  next.parentId ? list : [next, ...list.filter((r) => r.id !== next.id)].sort(byRecent);

/**
 * The daemon's round-ups: fetched once, then kept live by its event stream; plus rename and
 * delete. The same stream keeps harness usage (use-usage) current, and tells notifications
 * (use-attention) what needs the person, and the Workbench's cards (use-workbench).
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
          // Sent on every (re)connect: agent updates missed while away are caught up by refetching.
          sessions: (msg) => {
            const rows = JSON.parse(msg.data) as RoundUp[];
            queryClient.setQueryData(ROUND_UPS, rows);
            attention.sessions(rows);
            void queryClient.invalidateQueries({ queryKey: AGENTS });
          },
          // Straight after, on every (re)connect: which sub-agents are working, for notifications and the sidebar's dots.
          'sub-agents': (msg) => {
            const rows = JSON.parse(msg.data) as RoundUp[];
            queryClient.setQueryData(SUB_AGENTS, rows);
            attention.subAgents(rows);
          },
          // Sub-agents' too: notifications tell them apart from their round-up's by parentId.
          session: (msg) => {
            const info = JSON.parse(msg.data) as RoundUp;
            queryClient.setQueryData<RoundUp[]>(ROUND_UPS, (rows) => upsert(rows, info));
            if (info.parentId) queryClient.setQueryData<RoundUp[]>(SUB_AGENTS, (rows) => upsertSubAgent(rows, info));
            attention.session(info);
          },
          usage: (msg) => queryClient.setQueryData(USAGE, JSON.parse(msg.data) as HarnessUsage[]),
          agent: (msg) => {
            const agent = JSON.parse(msg.data) as AgentSummary;
            const key = agentsKey(agent.parentId);
            // A list being fetched may predate this update: fetch it again rather than lose it.
            if (queryClient.getQueryState(key)?.fetchStatus === 'fetching') void queryClient.invalidateQueries({ queryKey: key });
            else queryClient.setQueryData<AgentSummary[]>(key, (list) => upsertAgent(list, agent));
          },
          // Every round-up's open approvals as the stream connects, then each round-up's list as it changes.
          'approvals-snapshot': (msg) => {
            const all = JSON.parse(msg.data) as PendingApproval[];
            queryClient.setQueryData(APPROVALS, all);
            attention.approvalsSnapshot(all);
          },
          approvals: (msg) => {
            const { roundUpId, approvals } = JSON.parse(msg.data) as { roundUpId: string; approvals: PendingApproval[] };
            queryClient.setQueryData<PendingApproval[]>(APPROVALS, (all = []) => [...all.filter((a) => a.roundUpId !== roundUpId), ...approvals]);
            attention.approvals(roundUpId, approvals);
          },
          // The Workbench: every card on the board as the stream connects, then each card as it changes.
          workbench: (msg) => queryClient.setQueryData(WORKBENCH, JSON.parse(msg.data) as WorkbenchCard[]),
          card: (msg) => queryClient.setQueryData<WorkbenchCard[]>(WORKBENCH, (list) => upsertCard(list, JSON.parse(msg.data) as WorkbenchCard)),
          'card-removed': (msg) => queryClient.setQueryData<WorkbenchCard[]>(WORKBENCH, (list) => dropCard(list, (JSON.parse(msg.data) as CardRemoved).id)),
          deleted: (msg) => {
            const { id } = JSON.parse(msg.data) as { id: string };
            queryClient.setQueryData<RoundUp[]>(ROUND_UPS, (rows) => rows?.filter((r) => r.id !== id));
            queryClient.setQueryData<RoundUp[]>(SUB_AGENTS, (rows) => dropSession(rows, id));
            attention.deleted(id);
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
    onSuccess: (_, id) => {
      queryClient.setQueryData<RoundUp[]>(ROUND_UPS, (rows) => rows?.filter((r) => r.id !== id));
      queryClient.setQueryData<RoundUp[]>(SUB_AGENTS, (rows) => dropSession(rows, id));
    },
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
