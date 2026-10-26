import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { roundUpPath, type OpenedFrom } from '@/lib/round-ups';

/**
 * Opens a session's own page (a sub-agent's, say) as a new history entry, noting the page it was
 * opened from: its back button can then step back through history rather than push a new entry.
 */
export function useOpenSession() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return useCallback((id: string) => void navigate(roundUpPath(id), { state: { from: pathname } satisfies OpenedFrom }), [navigate, pathname]);
}
