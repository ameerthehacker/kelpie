import type { ReactNode } from 'react';
import { NotificationsMenu } from '@/components/shell/notifications-menu';
import { ThemeSwitch } from '@/components/shell/theme-switch';

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

/** Settings › General: the theme and notifications, the same controls as the sidebar's footer. Kept in this browser. */
export function GeneralSection() {
  return (
    <section id="general" aria-labelledby="general-title" className="flex scroll-mt-4 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="general-title" className="font-heading text-xl font-semibold tracking-[-0.02em]">
          General
        </h2>
        <p className="text-mu text-[13px]">Kept in this browser; the sidebar has them too.</p>
      </div>
      <div className="bg-surf border-ln divide-ln flex flex-col divide-y rounded-[20px] border">
        <Row title="Theme" hint="System follows your computer’s light or dark setting.">
          <ThemeSwitch />
        </Row>
        <Row title="Notifications" hint="A ping, with a sound, when agents need you while you’re away.">
          <NotificationsMenu />
        </Row>
      </div>
    </section>
  );
}
