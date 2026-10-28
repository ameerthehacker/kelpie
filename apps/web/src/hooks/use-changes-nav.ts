import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

export type RoundUpTab = 'conversation' | 'changes' | 'artifacts';

const TABS: RoundUpTab[] = ['changes', 'artifacts'];

/** The tab `?tab=` names; the conversation for none, or for anything it doesn't know. */
export const tabOf = (param: string | null): RoundUpTab => TABS.find((t) => t === param) ?? 'conversation';

/**
 * Where the person is in a round-up's changes, kept in the query string so it survives a reload
 * and the back button: `?tab=changes` (or `artifacts`), and full screen as `?full=feature|<agentId>&file=<path>`.
 */
export function useChangesNav() {
  const [params, setParams] = useSearchParams();
  const tab = tabOf(params.get('tab'));
  const full = params.get('full') ?? undefined;
  const file = params.get('file') ?? undefined;
  const roundParam = params.get('round');
  const round = roundParam ? Number(roundParam) : undefined;

  const update = useCallback(
    (change: (p: URLSearchParams) => void, replace = false) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          change(next);
          return next;
        },
        { replace },
      ),
    [setParams],
  );

  return useMemo(
    () => ({
      tab,
      full,
      file,
      setTab: (t: RoundUpTab) => update((p) => (t === 'conversation' ? p.delete('tab') : p.set('tab', t))),
      round,
      /** `full`: 'feature', or an agent's id (and the round of its work on show). */
      openFull: (which: string, path?: string, round?: number) =>
        update((p) => {
          p.set('full', which);
          if (path) p.set('file', path);
          else p.delete('file');
          if (round !== undefined) p.set('round', String(round));
          else p.delete('round');
        }),
      /** Moving between files in full screen does not stack up history. */
      showFile: (path: string) => update((p) => p.set('file', path), true),
      closeFull: () =>
        update((p) => {
          p.delete('full');
          p.delete('file');
          p.delete('round');
        }),
    }),
    [tab, full, file, round, update],
  );
}
