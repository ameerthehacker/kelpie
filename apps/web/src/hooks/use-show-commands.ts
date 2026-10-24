import { useSyncExternalStore } from 'react';

// "Show commands" is one switch for the whole app (the chat and the agent pane), remembered per browser.
const KEY = 'kelpie.show-commands';
const listeners = new Set<() => void>();

let on = (() => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
})();

function toggle() {
  on = !on;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {}
  listeners.forEach((l) => l());
}

/** Whether steps show the raw command behind them, and the switch. */
export function useShowCommands(): [boolean, () => void] {
  const value = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => on,
  );
  return [value, toggle];
}
