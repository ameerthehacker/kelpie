import { useSyncExternalStore } from 'react';
import { DEFAULT_SETTINGS, parseSettings, type AttentionSettings, type AttentionSummary } from './attention.js';

// Notification settings, remembered per browser like the theme.
const KEY = 'kelpie.notifications';
const listeners = new Set<() => void>();

function read(): AttentionSettings {
  try {
    return parseSettings(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let current = read();

// Changed in another tab: this one follows (it may be the one that notifies).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return;
    current = read();
    listeners.forEach((l) => l());
  });
}

export const notificationSettings = () => current;

export function setNotificationSettings(patch: Partial<AttentionSettings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {}
  listeners.forEach((l) => l());
}

export function useNotificationSettings(): AttentionSettings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

export type Permission = NotificationPermission | 'unsupported';

export const permission = (): Permission => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

/**
 * Turns notifications on; asks the browser for permission first, so call it from a click.
 * Turned on even if banners are refused: the chime still plays.
 */
export async function enableNotifications(): Promise<Permission> {
  let p = permission();
  if (p === 'default') p = await requestPermission();
  setNotificationSettings({ enabled: true }); // re-renders the menu, which reads the permission
  return p;
}

/** Older Safari takes a callback and returns nothing; newer browsers return a promise. */
function requestPermission(): Promise<NotificationPermission> {
  return new Promise((resolve) => {
    try {
      const asked = Notification.requestPermission(resolve) as Promise<NotificationPermission> | undefined;
      asked?.then(resolve, () => resolve('default'));
    } catch {
      resolve('default');
    }
  });
}

/** The tab is hidden, or another window has focus. */
export const isAway = () => document.visibilityState === 'hidden' || !document.hasFocus();

// One notification at a time: each replaces the last (the same tag), so the tray never stacks.
const TAG = 'kelpie-attention';
let shown: Notification | undefined;

/** Our notification is still in the tray: not clicked, dismissed, or closed as the person came back. */
export const notificationShowing = () => !!shown;

/**
 * Shows a bundle. An alert is a fresh banner (the old one closed first); otherwise the one in the
 * tray is updated in place, which the OS does without a banner (the tracker only asks for that
 * while `notificationShowing`). Our own chime is the sound.
 */
export function showNotification(summary: AttentionSummary, alert: boolean, onClick: (path: string) => void) {
  if (permission() !== 'granted') return;
  if (alert) shown?.close();
  try {
    const n = new Notification(summary.title, { body: summary.body, tag: TAG, icon: '/favicon.svg', silent: true });
    n.onclick = () => {
      window.focus();
      onClick(summary.path);
      n.close();
    };
    n.onclose = () => {
      if (shown === n) shown = undefined;
    };
    shown = n;
  } catch {
    // Some browsers (Android Chrome) only show notifications from a service worker.
  }
}

/** The person is back: what the notification said is on screen now. */
export function closeNotification() {
  shown?.close();
  shown = undefined;
}

let audio: AudioContext | undefined;

/**
 * Browsers only let a page make sound after the person has interacted with it; an AudioContext
 * made (or resumed) during a click keeps that permission for later, background chimes.
 */
export function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume().catch(() => {});
  } catch {}
}

/** A soft two-note chime (E5 then A5, bell-like decay), made with Web Audio: no asset to license. */
export function playChime() {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    if (ctx.state === 'running') return ring(ctx);
    // Still locked (no click on the page yet): a resume only goes through with one. Ring if it does
    // so straight away, rather than chime late at some later click.
    const asked = performance.now();
    void ctx.resume().then(
      () => performance.now() - asked < 1_000 && ring(ctx),
      () => {},
    );
  } catch {}
}

function ring(ctx: AudioContext) {
  const out = ctx.createGain();
  out.gain.value = 0.18;
  out.connect(ctx.destination);
  const start = ctx.currentTime + 0.02;
  for (const [freq, at] of [
    [659.25, 0],
    [880, 0.14],
  ] as const) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0.0001, start + at);
    env.gain.exponentialRampToValueAtTime(1, start + at + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.9);
    osc.connect(env).connect(out);
    osc.start(start + at);
    osc.stop(start + at + 0.95);
  }
}
