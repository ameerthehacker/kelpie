import { useEffect, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { createAttention, type Attention } from '@/lib/attention';
import { closeNotification, isAway, notificationSettings, playChime, showNotification, unlockAudio } from '@/lib/notifications';

let open = (path: string) => window.location.assign(path);

/** What needs the person, fed by the daemon's event stream (use-round-ups); notifies while they are away. */
export const attention = createAttention({
  settings: notificationSettings,
  away: isAway,
  deliver: ({ summary, alert }) => {
    showNotification(summary, alert, (path) => open(path));
    if (alert && notificationSettings().sound) playChime();
  },
});

/**
 * Hooks notifications up to the page: a click on one opens what it is about, the person coming
 * back marks it seen, and their clicks unlock the chime. Returns what they were notified of
 * while away and haven't come back to yet.
 */
export function useAttention(): readonly Attention[] {
  const navigate = useNavigate();
  useEffect(() => {
    open = (path) => void navigate(path);
  }, [navigate]);

  useEffect(() => {
    const back = () => {
      if (isAway()) return;
      attention.seen();
      closeNotification();
    };
    const unlock = () => {
      const s = notificationSettings();
      if (s.enabled && s.sound) unlockAudio();
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    return () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
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
