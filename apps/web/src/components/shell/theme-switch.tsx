import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { setTheme, useTheme, type Theme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const THEMES: { value: Theme; label: string; Icon: typeof SunIcon }[] = [
  { value: 'system', label: 'System theme', Icon: MonitorIcon },
  { value: 'light', label: 'Light theme', Icon: SunIcon },
  { value: 'dark', label: 'Dark theme', Icon: MoonIcon },
];

/** System, light or dark, as the design's three-way switch. */
export function ThemeSwitch() {
  const theme = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className="bg-chip flex gap-0.5 rounded-full p-[3px]">
      {THEMES.map(({ value, label, Icon }) => {
        const on = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn('flex size-7 items-center justify-center rounded-full', on ? 'bg-surf text-fg shadow-[0_1px_3px_rgba(0,0,0,0.18)]' : 'text-mu2 hover:text-fg')}
          >
            <Icon className="size-3.5" strokeWidth={1.9} />
          </button>
        );
      })}
    </div>
  );
}
