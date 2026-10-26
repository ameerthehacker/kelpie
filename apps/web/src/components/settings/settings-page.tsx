import { ConnectionsSection } from '@/components/settings/connections-section';
import { HarnessSection } from './harness-section';

/** Settings: one section after another, each in its own file. */
export function SettingsPage() {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-10 overflow-y-auto px-7 pt-2 pb-10 max-sm:px-4">
      <h1 className="font-heading text-[34px] leading-[1.05] font-semibold tracking-[-0.035em]">Settings</h1>
      <HarnessSection />
      <ConnectionsSection />
    </div>
  );
}
