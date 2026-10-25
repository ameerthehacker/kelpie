import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, HttpError } from '@/lib/api';
import { withThread, type Anchor, type Review, type ReviewComment, type ReviewState, type ReviewThread, type Verdict } from '@/lib/review';
import { CHANGES } from './use-changes';

export const reviewKey = (roundUpId: string | undefined) => ['review', roundUpId] as const;

/** The anchor's line is no longer what it was: the diff moved on under the person. */
export const isStale = (err: unknown) => err instanceof HttpError && err.status === 409;

/**
 * A round-up's review as the person sees it: fetched, then kept live by the stream's `review`
 * events (use-round-ups), which is how agents' replies and resolutions arrive. Every write also
 * folds its answer in, so the person sees it before the event.
 */
export function useReview(roundUpId: string | undefined) {
  const queryClient = useQueryClient();
  const key = reviewKey(roundUpId);
  const base = `/api/sessions/${roundUpId}/review`;
  const state = useQuery({
    queryKey: key,
    queryFn: () => api<ReviewState>('GET', base),
    enabled: !!roundUpId,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const fold = (thread: ReviewThread, review?: Review) => queryClient.setQueryData<ReviewState>(key, (s) => withThread(s, thread, review));

  const comment = useMutation({
    mutationFn: (input: { anchor: Anchor; body: string } | { threadId: string; body: string }) =>
      api<{ thread: ReviewThread; review: Review }>('POST', `${base}/comments`, input),
    onSuccess: ({ thread, review }) => fold(thread, review),
    // A stale anchor: the diff the person commented on is not the current one any more.
    onError: (err, input) => {
      if (isStale(err) && 'anchor' in input) void queryClient.invalidateQueries({ queryKey: [CHANGES] });
    },
  });
  const edit = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => api<ReviewComment>('PATCH', `${base}/comments/${id}`, { body }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api('DELETE', `${base}/comments/${id}`),
    onSettled: refresh,
  });
  const discard = useMutation({ mutationFn: () => api('DELETE', `${base}/pending`), onSettled: refresh });
  const submit = useMutation({
    mutationFn: ({ verdict, body }: { verdict: Verdict; body: string }) => api<{ review: Review }>('POST', `${base}/submit`, { verdict, ...(body.trim() ? { body: body.trim() } : {}) }),
    onSettled: refresh,
  });
  const resolve = useMutation({
    mutationFn: ({ threadId, resolved }: { threadId: string; resolved: boolean }) => api<ReviewThread>('POST', `${base}/threads/${threadId}/resolve`, { resolved }),
    onSuccess: (thread) => fold(thread),
  });

  const threads = state.data?.threads;
  const byId = useMemo(() => new Map((threads ?? []).map((t) => [t.id, t])), [threads]);

  return {
    state: state.data,
    error: state.error?.message,
    byId,
    comment: comment.mutateAsync,
    edit: edit.mutateAsync,
    remove: remove.mutateAsync,
    discard: discard.mutateAsync,
    submit: submit.mutateAsync,
    resolve: resolve.mutateAsync,
  };
}

export type ReviewApi = ReturnType<typeof useReview>;
