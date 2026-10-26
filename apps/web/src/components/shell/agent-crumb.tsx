import { ChevronLeftIcon } from 'lucide-react';
import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { roundUpPath, titleOf, type OpenedFrom, type RoundUp } from '@/lib/round-ups';

/** Escape is the person's to use while a dialog or menu is open, while they are typing something, or in a question card. */
function escapeIsFree(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]')) return false;
  const t = e.target;
  if (t instanceof Element && t.closest('[data-question-card]')) return false;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return !t.value;
  if (t instanceof HTMLElement && t.isContentEditable) return !t.textContent;
  return true;
}

/**
 * The header's way back from a sub-agent's own page to its round-up's chat: "‹ Round-up / Agent",
 * and Escape. Opened from that chat, it steps back through history (the browser's back and
 * forward stay in line); landed on directly, it opens the round-up.
 */
export function AgentCrumb({ agent, roundUp }: { agent: RoundUp; roundUp: RoundUp | undefined }) {
  const navigate = useNavigate();
  const { state } = useLocation();
  const to = roundUpPath(agent.parentId!);
  const back = useCallback(() => void ((state as OpenedFrom | null)?.from === to ? navigate(-1) : navigate(to)), [navigate, state, to]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !escapeIsFree(e)) return;
      e.preventDefault();
      back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back]);

  const name = roundUp ? titleOf(roundUp) : 'Round-up';
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap gap-1 text-[13px]">
        <BreadcrumbItem className="min-w-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <BreadcrumbLink asChild>
                <button
                  type="button"
                  onClick={back}
                  aria-label={`Back to ${name}`}
                  aria-keyshortcuts="Escape"
                  className="text-mu hover:bg-hov hover:text-fg -ml-1 flex h-[34px] min-w-0 items-center gap-1 rounded-lg pr-2.5 pl-1.5"
                >
                  <ChevronLeftIcon className="size-4 shrink-0" strokeWidth={2} />
                  <span className="max-w-[260px] truncate">{name}</span>
                </button>
              </BreadcrumbLink>
            </TooltipTrigger>
            <TooltipContent>
              Back to Kelpie's chat <Kbd>Esc</Kbd>
            </TooltipContent>
          </Tooltip>
        </BreadcrumbItem>
        {/* On a phone the agent's own title, just below, says where this is. */}
        <BreadcrumbSeparator className="text-fa max-sm:hidden">/</BreadcrumbSeparator>
        <BreadcrumbItem className="min-w-0 max-sm:hidden">
          <BreadcrumbPage className="text-fg truncate">{titleOf(agent)}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
