import { ConnectionsSection } from '@/components/settings/connections-section';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AgentsSection } from './agents-section';
import { GeneralSection } from './general-section';
import { HarnessSection } from './harness-section';

/** Settings: one section after another, each in its own file. The whole width scrolls, so the scrollbar sits at the edge, not beside the column. */
export function SettingsPage() {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-10 px-7 pt-2 pb-10 max-sm:px-4">
        <h1 className="font-heading text-[34px] leading-[1.05] font-semibold tracking-[-0.035em]">Settings</h1>
        <AgentsSection />
        <GeneralSection />
        <HarnessSection />
        <ConnectionsSection />
      </div>
    </ScrollArea>
  );
}
