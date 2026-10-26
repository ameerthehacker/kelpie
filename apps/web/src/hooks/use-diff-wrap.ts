import { useSyncExternalStore } from 'react';

/** Where a diff is read: the Changes tab, the agent pane, or full screen. Each wraps on its own. */
export type DiffPlace = 'changes' | 'agent' | 'full';

// "Wrap lines" is a switch per place, remembered per browser; off, long lines scroll sideways.
const key = (place: DiffPlace) => `kelpie.diff-wrap.${place}`;
const listeners = new Set<() => void>();
const wrap: Partial<Record<DiffPlace, boolean>> = {};

function read(place: DiffPlace): boolean {
  if (wrap[place] === undefined) {
    try {
      wrap[place] = localStorage.getItem(key(place)) === '1';
    } catch {
      wrap[place] = false;
    }
  }
  return wrap[place];
}

function toggle(place: DiffPlace) {
  wrap[place] = !read(place);
  try {
    localStorage.setItem(key(place), wrap[place] ? '1' : '0');
  } catch {}
  listeners.forEach((l) => l());
}

/** Whether diffs in `place` wrap long lines, and the switch. */
export function useDiffWrap(place: DiffPlace): [boolean, () => void] {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => read(place),
  );
  return [value, () => toggle(place)];
}
