// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Mode, SlashCommand } from '@kelpie/protocol';
import { Composer } from '../../src/components/chat/composer.js';

// React only runs effects inside `act` when it is told it is under test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const command = (name: string, description = ''): SlashCommand => ({ name, description, argumentHint: '', aliases: [], source: 'built-in' });
const COMMANDS = [command('compact', 'Free up context'), command('context', 'Show current context usage'), command('front:comp', 'Make a component')];
const FILES = ['apps/web/src/components/chat/composer.tsx', 'apps/web/src/lib/utils.ts'];
const AGENTS = [{ id: 'a1', parentId: 'r1', title: 'Checkout API', harness: 'claude-code', writes: true, browser: false, status: 'working', now: '', todos: [], createdAt: 1, updatedAt: 1 }];

let root: Root;
let host: HTMLDivElement;
let send: Mock<(text: string, files: File[]) => Promise<void>>;
let onMode: Mock<(mode: Mode) => void>;
let asked: string[];

beforeEach(() => {
  asked = [];
  vi.stubGlobal('fetch', async (url: string) => {
    asked.push(url);
    const u = new URL(url, 'http://localhost');
    const body =
      u.pathname === '/api/suggestions/commands'
        ? { commands: COMMANDS }
        : u.pathname === '/api/suggestions/files'
          ? { files: FILES.filter((f) => f.includes(u.searchParams.get('q') ?? '')), total: FILES.length }
          : u.pathname === '/api/sessions/r1/agents'
            ? AGENTS
            : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  send = vi.fn(async () => {});
  onMode = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Composer, {
          status: 'ready',
          busy: false,
          send,
          interrupt: () => {},
          model: '',
          onModel: () => {},
          effort: '',
          onEffort: () => {},
          base: '',
          onBase: () => {},
          branches: [],
          baseLocked: false,
          baseClearable: true,
          mode: 'auto',
          modes: ['auto', 'plan'],
          onMode,
          delegation: 'balanced',
          sessionId: 'r1',
          mentionRoundUpId: 'r1',
        }),
      ),
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const box = () => host.querySelector('textarea')!;
const settle = () => act(() => new Promise((r) => setTimeout(r, 200)));

async function type(text: string, wait = true) {
  const el = box();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
    el.setSelectionRange(text.length, text.length);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  if (wait) await settle();
}

const press = (key: string, opts: KeyboardEventInit = {}) =>
  act(() => {
    box().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
  });

const options = () => [...document.querySelectorAll('[cmdk-item]')].map((o) => o.textContent);
const selected = () => document.querySelector('[cmdk-item][data-selected="true"]')?.textContent;

describe('the composer suggestions', () => {
  it('offers slash commands at the start; Down moves, Enter puts one in without sending', async () => {
    await type('/');
    expect(box().getAttribute('aria-expanded')).toBe('true');
    expect(options()).toHaveLength(3);
    expect(selected()).toContain('/compact');
    await press('ArrowDown');
    expect(selected()).toContain('/context');
    await press('ArrowUp');
    await press('ArrowUp');
    expect(selected()).toContain('/front:comp');
    await press('Enter');
    expect(box().value).toBe('/front:comp ');
    expect(send).not.toHaveBeenCalled();
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(asked.filter((u) => u.startsWith('/api/suggestions/commands'))).toEqual(['/api/suggestions/commands?session=r1&']);
  });

  it('filters as the person types, and Tab accepts too', async () => {
    await type('/cont');
    expect(selected()).toContain('/context');
    await press('Tab');
    expect(box().value).toBe('/context ');
  });

  it('closes on Esc, and Enter then sends as usual', async () => {
    await type('/comp');
    await press('Escape');
    expect(box().getAttribute('aria-expanded')).toBe('false');
    await press('Enter');
    expect(send).toHaveBeenCalledWith('/comp', []);
  });

  it('sends on Enter when nothing matches, and keeps Shift+Tab for the mode', async () => {
    await type('/nothing-like-it');
    await press('Tab', { shiftKey: true });
    expect(onMode).toHaveBeenCalledWith('plan');
    await press('Enter');
    expect(send).toHaveBeenCalledWith('/nothing-like-it', []);
  });

  it('mentions agents and files after @, anywhere in the message', async () => {
    await type('look at @');
    expect(options()).toEqual([expect.stringContaining('Checkout API'), expect.stringContaining(FILES[0]!), expect.stringContaining(FILES[1]!)]);
    await type('look at @utils', false);
    // Before the daemon answers, its last matches are narrowed to what's typed.
    expect(options()).toEqual([expect.stringContaining(FILES[1]!)]);
    await settle();
    expect(asked.some((u) => u.includes('q=utils'))).toBe(true);
    expect(options()).toEqual([expect.stringContaining(FILES[1]!)]);
    await press('Enter');
    expect(box().value).toBe(`look at @${FILES[1]} `);
    await type('ask @Check');
    await press('Enter');
    expect(box().value).toBe('ask @Checkout API ');
    expect(send).not.toHaveBeenCalled();
  });

  it('opens nothing for plain text, an email address, or a slash mid-message', async () => {
    for (const text of ['hello', 'mail me@example.com', 'see src/']) {
      await type(text);
      expect(box().getAttribute('aria-expanded')).toBe('false');
    }
    await press('Enter');
    expect(send).toHaveBeenCalledWith('see src/', []);
  });
});
