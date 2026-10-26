import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useTheme } from '@/lib/theme';

/** Toasts (sonner) in Kelpie's colours, following its theme. */
function Toaster(props: ToasterProps) {
  const theme = useTheme();
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={{ '--normal-bg': 'var(--surf)', '--normal-text': 'var(--fg)', '--normal-border': 'var(--ln2)', '--border-radius': '12px' } as React.CSSProperties}
      toastOptions={{ classNames: { toast: 'shadow-card text-[13px]', actionButton: '!bg-acc !text-accfg' } }}
      {...props}
    />
  );
}

export { Toaster };
