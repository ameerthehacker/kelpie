import { BellIcon, BellOffIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { testNotification } from '@/hooks/use-attention';
import type { AttentionLevel } from '@/lib/attention';
import { enableNotifications, permission, setNotificationSettings, unlockAudio, useNotificationSettings } from '@/lib/notifications';

const keepOpen = (e: Event) => e.preventDefault();

/** On or off, the chime, and how much to hear about: the sidebar's notification settings. */
export function NotificationsMenu() {
  const settings = useNotificationSettings();
  const p = permission();
  const Icon = settings.enabled ? BellIcon : BellOffIcon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Notification settings"
        title={settings.enabled ? 'Notifications on' : 'Notifications off'}
        className="bg-chip text-mu2 hover:text-fg data-[state=open]:text-fg flex h-[34px] items-center gap-1.5 rounded-full px-3 text-xs"
      >
        <Icon className="size-3.5" strokeWidth={1.9} />
        {settings.enabled ? 'On' : 'Off'}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-64">
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={settings.enabled}
          onSelect={keepOpen}
          onCheckedChange={(on) => (on ? void enableNotifications() : setNotificationSettings({ enabled: false }))}
        >
          Notify me when I’m away
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={settings.sound}
          disabled={!settings.enabled}
          onSelect={keepOpen}
          onCheckedChange={(on) => {
            if (on) unlockAudio();
            setNotificationSettings({ sound: on });
          }}
        >
          Play a sound
        </DropdownMenuCheckboxItem>
        {settings.enabled && p === 'denied' && (
          <p className="text-mu2 px-1.5 py-1 text-xs">The browser blocks Kelpie’s notifications; allow them in its site settings. The sound still plays.</p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Tell me</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={settings.level} onValueChange={(level) => setNotificationSettings({ level: level as AttentionLevel })}>
          <DropdownMenuRadioItem value="needed" disabled={!settings.enabled} onSelect={keepOpen}>
            Only when I’m needed
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="all" disabled={!settings.enabled} onSelect={keepOpen}>
            Also when any agent finishes
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!settings.enabled} onSelect={testNotification}>
          Send a test notification
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const PROMPT_KEY = 'kelpie.notifications-prompt';

/** A one-time offer to turn notifications on; the browser's permission prompt follows the click. */
export function NotificationPrompt() {
  const settings = useNotificationSettings();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(PROMPT_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (dismissed || settings.enabled || permission() === 'unsupported' || permission() === 'denied') return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(PROMPT_KEY, '1');
    } catch {}
  };
  return (
    <div className="bg-chip text-fg2 mx-0.5 flex flex-col gap-2 rounded-xl py-2.5 pr-1.5 pl-3 text-[13px]">
      <div className="flex items-start gap-2">
        <BellIcon className="text-mu2 mt-0.5 size-3.5 shrink-0" strokeWidth={1.9} />
        <span className="flex-1 leading-snug">Get a ping when agents need you, with a sound.</span>
        <button type="button" onClick={dismiss} aria-label="Dismiss" className="text-mu2 hover:text-fg -mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md">
          <XIcon className="size-3.5" />
        </button>
      </div>
      <button
        type="button"
        onClick={() => {
          unlockAudio();
          void enableNotifications().then(dismiss);
        }}
        className="bg-surf hover:bg-raise text-fg ml-5.5 self-start rounded-lg px-2.5 py-1 text-xs font-medium"
      >
        Turn on notifications
      </button>
    </div>
  );
}
