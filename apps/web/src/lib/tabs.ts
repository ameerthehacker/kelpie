/**
 * Kelpie open in several tabs: one of them (the holder of a Web Lock) notifies, so the person gets
 * one banner and one chime; and the tabs tell each other where the person is, so a hidden tab stays
 * quiet while they are in another, and looking in any tab makes what was notified seen in all.
 */

type Message = { type: 'here'; id: string; here: boolean } | { type: 'hello'; id: string } | { type: 'seen' };

export interface TabChannel {
  postMessage(message: Message): void;
  addEventListener(type: 'message', listener: (e: { data: Message }) => void): void;
}

/** What is used of the Web Locks API (`navigator.locks`). */
export interface Locks {
  request(name: string, granted: () => Promise<never>): Promise<unknown>;
}

export interface TabsOptions {
  /** How the tabs talk; without one (no BroadcastChannel) each tab is on its own. */
  channel?: TabChannel;
  /** Picks the tab that notifies; without it (no Web Locks) every tab does, as a lone tab would. */
  locks?: Locks;
  id?: string;
}

export interface Tabs {
  /** This tab is the one that notifies. */
  leader(): boolean;
  /** The person is in another Kelpie tab. */
  elsewhere(): boolean;
  /** Whether the person is in this tab, whenever that may have changed. */
  presence(here: boolean): void;
  /** The person looked, in this tab: the others mark it seen too. */
  seen(): void;
  /** They looked in another tab. */
  onSeen(listener: () => void): () => void;
}

export const LEADER_LOCK = 'kelpie.notifications';

export function createTabs({ channel, locks, id = crypto.randomUUID() }: TabsOptions): Tabs {
  let leading = !locks;
  let here = false;
  const others = new Set<string>();
  const seenListeners = new Set<() => void>();

  // Held for as long as the tab lives; the browser hands it on as the tab closes.
  locks
    ?.request(LEADER_LOCK, () => {
      leading = true;
      return new Promise<never>(() => {});
    })
    .catch(() => (leading = true));

  channel?.addEventListener('message', ({ data: m }) => {
    if (m.type === 'here') {
      if (m.here) others.add(m.id);
      else others.delete(m.id);
    } else if (m.type === 'hello') {
      if (here) channel.postMessage({ type: 'here', id, here });
    } else seenListeners.forEach((l) => l());
  });
  // A new tab asks where the person is.
  channel?.postMessage({ type: 'hello', id });

  return {
    leader: () => leading,
    elsewhere: () => others.size > 0,
    presence(next) {
      if (next === here) return;
      here = next;
      channel?.postMessage({ type: 'here', id, here });
    },
    seen: () => channel?.postMessage({ type: 'seen' }),
    onSeen(listener) {
      seenListeners.add(listener);
      return () => seenListeners.delete(listener);
    },
  };
}
