/// <reference lib="dom" />
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileCard, WrapToggle } from '../../src/components/changes/file-card.js';
import type { ChangedFile } from '../../src/lib/changes.js';

// React only runs effects inside `act` when it is told it is under test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file = (i: number): ChangedFile => ({
  path: `pkg/area${i % 7}/component-${i}.tsx`,
  status: 'added',
  binary: false,
  additions: 30 + i,
  deletions: i % 3,
  agents: [{ id: 'a1', title: 'Big', harness: 'claude-code' }],
  patch: `diff --git a/x b/x\n`,
});
const scope = { roundUpId: 'r1', view: 'agent' as const, viewSessionId: 'a1' };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('FileCard', () => {
  it("shows each collapsed file's header in a long list: path, counts, chevron and full screen", () => {
    const files = Array.from({ length: 178 }, (_, i) => file(i));
    const onToggle = vi.fn();
    act(() =>
      root.render(
        createElement(
          'div',
          { className: 'flex min-h-0 flex-1 flex-col overflow-y-auto' },
          files.map((f) => createElement(FileCard, { key: f.path, compact: true, file: f, threads: [], scope, sessionId: 'a1', collapsed: true, onToggle, onFullScreen: () => {} })),
        ),
      ),
    );
    const cards = host.querySelectorAll<HTMLElement>('[data-file]');
    expect(cards).toHaveLength(178);
    const card = cards[5]!;
    expect(card.textContent).toContain('pkg/area5/');
    expect(card.textContent).toContain('component-5.tsx');
    expect(card.querySelector('[aria-label="35 added, 2 removed"]')?.textContent).toBe('+35−2');
    expect(card.querySelector('button[aria-expanded="false"] svg')).not.toBeNull();
    expect(card.querySelector('[aria-label="Open pkg/area5/component-5.tsx full screen"]')).not.toBeNull();
    // In a flex column that scrolls, a card that clips its overflow shrinks to its border unless told not to.
    expect([...cards].every((c) => c.classList.contains('shrink-0') && c.classList.contains('overflow-hidden'))).toBe(true);
    act(() => card.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe('WrapToggle', () => {
  it('says whether it is on by being pressed and raised, not with a ring', () => {
    const render = (wrap: boolean) => act(() => root.render(createElement(WrapToggle, { wrap, onToggle: () => {}, iconOnly: true })));
    render(true);
    const button = host.querySelector('button')!;
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Wrap lines');
    expect(button.classList.contains('bg-raise')).toBe(true);
    expect(button.className).not.toMatch(/shadow-\[inset|ring-/);
    render(false);
    expect(host.querySelector('button')!.getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('button')!.classList.contains('bg-raise')).toBe(false);
  });
});
