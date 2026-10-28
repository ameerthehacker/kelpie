import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BotIcon, FileIcon, SlashIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useDebounce } from 'use-debounce';
import type { FileMatches, SlashCommands } from '@kelpie/protocol';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useAgents } from '@/hooks/use-agents';
import { STATUS_LABEL } from '@/lib/agents';
import { api } from '@/lib/api';
import { agentMention, applySuggestion, fileMention, rankCommands, rankPaths, rankTitled, triggerAt } from '@/lib/suggestions';
import { cn } from '@/lib/utils';

/** Files are matched by the daemon, so it isn't asked on every keystroke. */
const FILE_DEBOUNCE_MS = 120;

const query = (sessionId: string | undefined) => (sessionId ? `session=${encodeURIComponent(sessionId)}&` : '');

interface Item {
  key: string;
  group: 'Commands' | 'Agents' | 'Files';
  /** What takes the trigger's place in the text. */
  insert: string;
  label: string;
  detail?: string;
  hint?: string;
  icon: ReactNode;
}

const GROUPS = ['Commands', 'Agents', 'Files'] as const;
const icon = 'text-mu2 size-3.5';

/**
 * The composer's `/` and `@` menu, driven from its textarea: the caret stays in the box, and these
 * keys go to the menu while it is open (`onKeyDown` says whether it took one). Up and Down move,
 * Enter or Tab puts the pick in, Esc closes it until the next trigger. With nothing matching, Enter
 * still sends (a command the list doesn't know is the person's call).
 */
export function useSuggestions({
  text,
  caret,
  sessionId,
  roundUpId,
  onApply,
}: {
  text: string;
  caret: number;
  /** The session the message goes to: its directory's commands and files. Undefined before a round-up exists. */
  sessionId: string | undefined;
  /** Whose agents can be mentioned. */
  roundUpId: string | undefined;
  onApply: (text: string, caret: number) => void;
}) {
  const trigger = triggerAt(text, caret);
  const [dismissed, setDismissed] = useState<string>();
  const id = trigger && `${trigger.kind}${trigger.start}`;
  const live = trigger && id !== dismissed ? trigger : undefined;
  const kind = live?.kind;

  const commands = useQuery({
    queryKey: ['suggestions', 'commands', sessionId ?? ''],
    queryFn: () => api<SlashCommands>('GET', `/api/suggestions/commands?${query(sessionId)}`).then((r) => r.commands),
    enabled: kind === '/',
    // The CLI's own list changes only with its version; the daemon keeps it for a while too.
    staleTime: 5 * 60_000,
  });
  const [fileQuery] = useDebounce(kind === '@' ? live!.query : '', FILE_DEBOUNCE_MS);
  const files = useQuery({
    queryKey: ['suggestions', 'files', sessionId ?? '', fileQuery],
    queryFn: () => api<FileMatches>('GET', `/api/suggestions/files?${query(sessionId)}q=${encodeURIComponent(fileQuery)}`),
    enabled: kind === '@',
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const agents = useAgents(kind === '@' ? roundUpId : undefined);

  const q = live?.query ?? '';
  // Until the daemon answers for what's typed now, its last matches, narrowed to it: never a stale pick on Enter.
  const fresh = !files.isPlaceholderData && fileQuery === q;
  const matched = useMemo(() => (fresh ? (files.data?.files ?? []) : rankPaths(files.data?.files ?? [], q)), [fresh, files.data, q]);
  const items = useMemo((): Item[] => {
    if (kind === '/') {
      return rankCommands(commands.data ?? [], q).map((c) => ({
        key: `/${c.name}`,
        group: 'Commands',
        insert: `/${c.name}`,
        label: `/${c.name}`,
        detail: c.description,
        hint: c.argumentHint,
        icon: <SlashIcon className={icon} strokeWidth={2} />,
      }));
    }
    if (kind === '@') {
      const mentionable = (agents ?? []).filter((a) => a.id !== sessionId);
      return [
        ...rankTitled(mentionable, q, 8).map((a): Item => ({
          key: `agent:${a.id}`,
          group: 'Agents',
          insert: agentMention(a.title),
          label: a.title,
          detail: STATUS_LABEL[a.status],
          icon: <BotIcon className={icon} strokeWidth={2} />,
        })),
        ...matched.map((f): Item => ({
          key: `file:${f}`,
          group: 'Files',
          insert: fileMention(f),
          label: f,
          icon: <FileIcon className={icon} strokeWidth={2} />,
        })),
      ];
    }
    return [];
  }, [kind, q, commands.data, agents, matched, sessionId]);

  const [active, setActive] = useState(0);
  // A new trigger, or more typed: the best match is picked again.
  useEffect(() => setActive(0), [id, q]);
  const selected = items[Math.min(active, items.length - 1)];
  const loading = kind === '/' ? commands.isPending : kind === '@' ? files.isPending : false;
  const open = !!live && (items.length > 0 || !loading);

  const pick = (item: Item) => {
    if (!live) return;
    const next = applySuggestion(text, live, item.insert);
    onApply(next.text, next.caret);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(id);
      return true;
    }
    if (!items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const at = items.indexOf(selected!);
      setActive((at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      pick(selected!);
      return true;
    }
    return false;
  };

  return {
    open,
    trigger: live,
    onKeyDown,
    menu: {
      open,
      items,
      selected: selected?.key,
      loading,
      kind,
      onHover: (key: string) => setActive(Math.max(0, items.findIndex((i) => i.key === key))),
      onPick: pick,
      onDismiss: () => setDismissed(id),
    },
  };
}

export type SuggestionMenuProps = ReturnType<typeof useSuggestions>['menu'];

/**
 * The menu itself, above the composer: put `children` (an empty anchor spanning the box's top edge)
 * where it should line up. It never takes focus, so typing goes on in the box.
 */
export function SuggestionMenu({ open, items, selected, loading, kind, onHover, onPick, onDismiss, listId, children }: SuggestionMenuProps & { listId: string; children: ReactNode }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[data-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return (
    <Popover open={open} onOpenChange={(o) => !o && onDismiss()}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="bg-surf text-fg w-(--radix-popover-trigger-width) max-w-[calc(100vw-1.5rem)] rounded-xl p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        // A click back in the box keeps the menu: it follows the caret there.
        onInteractOutside={(e) => e.target instanceof HTMLTextAreaElement && e.preventDefault()}
      >
        <Command shouldFilter={false} value={selected ?? ''} onValueChange={onHover} loop className="bg-surf rounded-xl">
          <CommandList id={listId} ref={list} className="max-h-72" aria-label={kind === '/' ? 'Slash commands' : 'Mentions'}>
            <CommandEmpty className="text-mu py-3 text-[13px]">{loading ? 'Loading…' : kind === '/' ? 'No command matches.' : 'No file or agent matches.'}</CommandEmpty>
            {GROUPS.map((group) => {
              const these = items.filter((i) => i.group === group);
              return (
                these.length > 0 && (
                  <CommandGroup key={group} heading={group}>
                    {these.map((i) => (
                      <CommandItem
                        key={i.key}
                        value={i.key}
                        onSelect={() => onPick(i)}
                        // Keeps the caret in the box.
                        onMouseDown={(e) => e.preventDefault()}
                        className="gap-2 py-1.5"
                      >
                        {i.icon}
                        <span className={cn('min-w-0 shrink-0 truncate text-[13px]', i.group === 'Files' ? 'font-mono text-xs' : 'font-medium', i.group === 'Files' && 'shrink')}>{i.label}</span>
                        {i.hint && <span className="text-mu2 shrink-0 font-mono text-xs">{i.hint}</span>}
                        {i.detail && <span className="text-mu min-w-0 flex-1 truncate text-xs">{i.detail}</span>}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

