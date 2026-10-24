import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';

// index.html applies the same key before first paint, so the page never flashes the wrong theme.
const KEY = 'kelpie.theme';
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let current = read();

function apply() {
  document.documentElement.classList.toggle('dark', current === 'dark' || (current === 'system' && prefersDark.matches));
}

/** Follows the saved choice, and the OS setting while that choice is "system". */
export function initTheme() {
  apply();
  prefersDark.addEventListener('change', apply);
}

export function setTheme(theme: Theme) {
  current = theme;
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {}
  apply();
  listeners.forEach((l) => l());
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
