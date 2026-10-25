import { useEffect, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { createAttention, type Attention } from '@/lib/attention';
import { closeNotification, isAway, notificationSettings, notificationShowing, playChime, showNotification, unlockAudio } from '@/lib/notifications';
import { createTabs } from '@/lib/tabs';

let open = (path: string) => window.location.assign(path);

const tabs = createTabs({
  channel: typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('kelpie.notifications'),
  locks: typeof navigator === 'undefined' ? undefined : navigator.locks,
});

/**
 * What needs the person, fed by the daemon's event stream (use-round-ups); notifies while they are
 * away from every Kelpie tab, and from one tab only.
 */
export const attention = createAttention({
  settings: notificationSettings,
  away: () => isAway() && !tabs.elsewhere(),
  showing: notificationShowing,
  deliver: ({ summary, alert }) => {
    if (!tabs.leader()) return;
    showNotification(summary, alert, (path) => open(path));
    if (alert && notificationSettings().sound) playChime();
  },
});

/**
 * Hooks notifications up to the page: a click on one opens what it is about, the person coming
 * back (to this tab or another) marks it seen, and their clicks unlock the chime. Returns what they were notified of
 * while away and haven't come back to yet.
 */
export function useAttention(): readonly Attention[] {
  const navigate = useNavigate();
  useEffect(() => {
    open = (path) => void navigate(path);
  }, [navigate]);

  useEffect(() => {
    const forget = () => {
      attention.seen();
      closeNotification();
    };
    const back = () => {
      const here = !isAway();
      tabs.presence(here);
      if (!here) return;
      forget();
      tabs.seen();
    };
    const gone = () => tabs.presence(false);
    back();
    const offSeen = tabs.onSeen(forget);
    const unlock = () => {
      const s = notificationSettings();
      if (s.enabled && s.sound) unlockAudio();
    };
    window.addEventListener('focus', back);
    window.addEventListener('blur', back);
    document.addEventListener('visibilitychange', back);
    window.addEventListener('pagehide', gone);
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    return () => {
      offSeen();
      window.removeEventListener('focus', back);
      window.removeEventListener('blur', back);
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('pagehide', gone);
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
  }, []);

  return useSyncExternalStore(attention.subscribe, attention.unseen);
}

/** What a notification looks and sounds like, on demand from the settings menu. */
export function testNotification() {
  unlockAudio();
  showNotification({ title: 'Kelpie', body: 'Notifications are on. You’ll hear from agents when they need you.', path: window.location.pathname }, true, (path) => open(path));
  if (notificationSettings().sound) playChime();
}
