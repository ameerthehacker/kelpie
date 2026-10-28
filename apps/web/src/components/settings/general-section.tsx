import type { ReactNode } from 'react';
import { NotificationsMenu } from '@/components/shell/notifications-menu';
import { ThemeSwitch } from '@/components/shell/theme-switch';
import { useSaveSettings, useSettings } from '@/hooks/use-settings';
import { DEFAULT_DELEGATION, DELEGATION_INFO, DELEGATIONS } from '@/lib/delegation';
import { cn } from '@/lib/utils';

function Row({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6 px-5 py-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[15px] font-medium">{title}</span>
        <p className="text-mu text-[13px]">{hint}</p>
      </div>
      {children}
    </div>
  );
}

/** The level new round-ups start at, as the theme's three-way switch; saved with the daemon. A round-up's own pill overrides it. */
export function DelegationSwitch() {
  const { data } = useSettings();
  const save = useSaveSettings();
  const current = data?.delegation ?? DEFAULT_DELEGATION;
  return (
    <div role="radiogroup" aria-label="Default delegation" className="bg-chip flex shrink-0 gap-0.5 rounded-full p-[3px]">
      {DELEGATIONS.map((d) => {
        const on = current === d;
        return (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={on}
            title={DELEGATION_INFO[d].detail}
            disabled={!data}
            onClick={() => !on && save.mutate({ delegation: d })}
            className={cn('h-7 rounded-full px-3 text-[13px]', on ? 'bg-surf text-fg shadow-[0_1px_3px_rgba(0,0,0,0.18)]' : 'text-mu2 hover:text-fg')}
          >
            {DELEGATION_INFO[d].label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Settings › General: the theme and notifications, the same controls as the sidebar's footer and
 * kept in this browser; and how much new round-ups delegate, saved with the daemon.
 */
export function GeneralSection() {
  const delegation = useSettings().data?.delegation ?? DEFAULT_DELEGATION;
  return (
    <section id="general" aria-labelledby="general-title" className="flex scroll-mt-4 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="general-title" className="font-heading text-xl font-semibold tracking-[-0.02em]">
          General
        </h2>
        <p className="text-mu text-[13px]">Theme and notifications are kept in this browser; the sidebar has them too.</p>
      </div>
      <div className="bg-surf border-ln divide-ln flex flex-col divide-y rounded-[20px] border">
        <Row title="Theme" hint="System follows your computer’s light or dark setting.">
          <ThemeSwitch />
        </Row>
        <Row title="Notifications" hint="A ping, with a sound, when agents need you while you’re away.">
          <NotificationsMenu />
        </Row>
        <Row title="Delegation" hint={`How much Kelpie hands to sub-agents in new round-ups. ${DELEGATION_INFO[delegation].label}: ${DELEGATION_INFO[delegation].detail}`}>
          <DelegationSwitch />
        </Row>
      </div>
    </section>
  );
}
