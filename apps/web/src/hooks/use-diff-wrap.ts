import { useCallback, useSyncExternalStore } from 'react';

/** Where a diff is read: the Changes tab, the agent pane, or full screen. Each wraps on its own. */
export type DiffPlace = 'changes' | 'agent' | 'full';

// "Wrap lines" is a switch per place, remembered per browser. Off, long lines scroll sideways; the
// agent pane is narrow, so it starts on there.
const PREFIX = 'kelpie.diff-wrap.';
const DEFAULT: Record<DiffPlace, boolean> = { changes: false, agent: true, full: false };
const listeners = new Set<() => void>();
const wrap: Partial<Record<DiffPlace, boolean>> = {};

function read(place: DiffPlace): boolean {
  if (wrap[place] === undefined) {
    try {
      const saved = localStorage.getItem(PREFIX + place);
      wrap[place] = saved === null ? DEFAULT[place] : saved === '1';
    } catch {
      wrap[place] = DEFAULT[place];
    }
  }
  return wrap[place];
}

function toggle(place: DiffPlace) {
  wrap[place] = !read(place);
  try {
    localStorage.setItem(PREFIX + place, wrap[place] ? '1' : '0');
  } catch {}
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

// Changed in another tab: this one follows.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== null && !e.key.startsWith(PREFIX)) return;
    for (const place of Object.keys(wrap) as DiffPlace[]) delete wrap[place];
    listeners.forEach((l) => l());
  });
}

/** Whether diffs in `place` wrap long lines, and the switch. */
export function useDiffWrap(place: DiffPlace): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, () => read(place));
  return [value, useCallback(() => toggle(place), [place])];
}
