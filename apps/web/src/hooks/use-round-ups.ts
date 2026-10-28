import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { liveStream } from '@/lib/live-stream';
import type { AgentSummary } from '@/lib/agents';
import { byRecent, type RoundUp } from '@/lib/round-ups';
import { AGENTS, agentsKey, upsertAgent } from './use-agents';
import type { HarnessUsage } from '@/lib/usage';
import { USAGE } from './use-usage';
import { settingsStream } from '@/lib/settings';
import { APPROVALS } from './use-approvals';
import type { PendingApproval } from '@/lib/approvals';
import { attention } from './use-attention';
import { dropSession, SUB_AGENTS, upsertSubAgent } from './use-round-up-status';
import type { ArtifactsChanged } from '@kelpie/protocol';
import type { ReviewState } from '@/lib/review';
import { reviewKey } from './use-review';
import { CHANGES } from './use-changes';
import { ARTIFACTS, artifactsKey, documentKey } from '@/lib/artifacts';
import { workbenchStream } from '@/lib/workbench';

const ROUND_UPS = ['round-ups'] as const;

/** Sub-agents are not listed in the sidebar; they belong to their orchestrator. */
const upsert = (list: RoundUp[] = [], next: RoundUp) =>
  next.parentId ? list : [next, ...list.filter((r) => r.id !== next.id)].sort(byRecent);

/**
 * The daemon's round-ups: fetched once, then kept live by its event stream; plus rename and
 * delete. The same stream keeps harness usage (use-usage) and settings (use-settings) current, and tells notifications
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
            // Reviews and diffs too: their events missed while away are not replayed.
            void queryClient.invalidateQueries({ queryKey: ['review'] });
            void queryClient.invalidateQueries({ queryKey: [CHANGES] });
            void queryClient.invalidateQueries({ queryKey: [ARTIFACTS] });
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
          // The person's settings, as the stream connects and as they change.
          ...settingsStream(queryClient),
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
          // Every change to a round-up's review, the agents' replies and resolutions among them.
          review: (msg) => {
            const { roundUpId, state } = JSON.parse(msg.data) as { roundUpId: string; state: ReviewState };
            queryClient.setQueryData(reviewKey(roundUpId), state);
          },
          // An agent went idle, or Muster merged: its diff and the feature's may have moved.
          changes: (msg) => {
            const { roundUpId, sessionId } = JSON.parse(msg.data) as { roundUpId: string; sessionId: string };
            void queryClient.invalidateQueries({ queryKey: [CHANGES, sessionId] });
            if (roundUpId !== sessionId) void queryClient.invalidateQueries({ queryKey: [CHANGES, roundUpId] });
          },
          // A file in a round-up's scratch folder was written: its documents, and that one if it is open.
          artifacts: (msg) => {
            const { roundUpId, path } = JSON.parse(msg.data) as ArtifactsChanged;
            void queryClient.invalidateQueries({ queryKey: artifactsKey(roundUpId), exact: true });
            void queryClient.invalidateQueries({ queryKey: documentKey(roundUpId, path), exact: true });
          },
          // The Workbench: every card on the board as the stream connects, then each card as it changes.
          ...workbenchStream(queryClient),
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
