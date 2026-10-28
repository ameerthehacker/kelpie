// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegationMenu } from '../../src/components/chat/composer-controls.js';
import type { Delegation } from '../../src/lib/delegation.js';

// React only runs effects inside `act` when it is told it is under test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let onDelegation: ReturnType<typeof vi.fn<(d: Delegation) => void>>;
const render = (delegation: Delegation) => act(() => root.render(createElement(DelegationMenu, { delegation, onDelegation })));
const trigger = () => host.querySelector<HTMLButtonElement>('button')!;
const open = async () => {
  await act(async () => {
    trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
};
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  onDelegation = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the delegation pill', () => {
  it('names the current level', () => {
    render('solo');
    expect(trigger().getAttribute('aria-label')).toBe('Delegation: Solo');
    expect(trigger().textContent).toContain('Solo');
  });

  it('offers the three levels, each with its line, the current one checked', async () => {
    render('balanced');
    await open();
    expect(items().map((i) => i.textContent)).toEqual([
      expect.stringContaining('Solo'),
      expect.stringContaining('Balanced'),
      expect.stringContaining('Delegate'),
    ]);
    expect(items()[0]!.textContent).toContain('fewest tokens');
    expect(items().map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
  });

  it('hands the picked level on', async () => {
    render('balanced');
    await open();
    await act(async () => items()[2]!.click());
    expect(onDelegation).toHaveBeenCalledWith('delegate');
  });
});
