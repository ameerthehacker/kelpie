/// <reference lib="dom" />
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoundUpTitle } from '../src/components/shell/round-up-title.js';
import { renameTo, type RoundUp } from '../src/lib/round-ups.js';

// React only runs effects inside `act` when it is told it is under test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Titled = Pick<RoundUp, 'id' | 'title' | 'titleSource'>;

describe('renaming a round-up', () => {
  it('sends a tidied new name, nothing when unchanged or blank, and a clear for the person’s own', () => {
    const ai: Titled = { id: 'r', title: 'Sentry client init', titleSource: 'ai' };
    expect(renameTo(ai, '  Sentry   errors ')).toBe('Sentry errors');
    expect(renameTo(ai, 'Sentry client init')).toBeUndefined();
    expect(renameTo(ai, '   ')).toBeUndefined();
    const mine: Titled = { id: 'r', title: 'Mine', titleSource: 'person' };
    expect(renameTo(mine, '')).toBe('');
    expect(renameTo(mine, 'Mine')).toBeUndefined();
  });
});

describe('the round-up title', () => {
  let root: Root;
  let host: HTMLDivElement;
  let renames: [string, string][];

  const render = (roundUp: Titled) =>
    act(() => root.render(createElement(RoundUpTitle, { roundUp, onRename: (id: string, title: string) => void renames.push([id, title]) })));
  const shown = () => host.querySelector('[role="button"]');
  const field = () => host.querySelector('input');
  const key = (el: Element, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));
  const edit = () => act(() => (shown() as HTMLElement).click());
  const type = (value: string) => {
    field()!.value = value;
  };

  beforeEach(() => {
    renames = [];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('shows the title, and "New round-up" until there is one', () => {
    render({ id: 'r', title: '', titleSource: undefined });
    expect(host.textContent).toBe('New round-up');
    render({ id: 'r', title: 'Sentry client init', titleSource: 'ai' });
    expect(host.querySelector('h1')!.textContent).toBe('Sentry client init');
    expect(shown()!.getAttribute('title')).toBe('Named by Claude · click to rename');
  });

  it('fades a title in when it changes in place, not on first render', () => {
    render({ id: 'r', title: 'Lets cp this https://github…', titleSource: 'message' });
    expect(shown()!.firstElementChild!.className).not.toContain('fade-in');
    render({ id: 'r', title: 'Shop CI setup', titleSource: 'ai' });
    expect(shown()!.firstElementChild!.className).toContain('fade-in');
  });

  it('saves on Enter', () => {
    render({ id: 'r', title: 'Sentry client init', titleSource: 'ai' });
    edit();
    expect(document.activeElement).toBe(field());
    type('Sentry release health');
    key(field()!, 'Enter');
    expect(renames).toEqual([['r', 'Sentry release health']]);
    expect(field()).toBeNull();
  });

  it('cancels on Escape, and leaves an unchanged title be', () => {
    render({ id: 'r', title: 'Sentry client init', titleSource: 'ai' });
    edit();
    type('Something else');
    key(field()!, 'Escape');
    expect(renames).toEqual([]);
    expect(host.querySelector('h1')!.textContent).toBe('Sentry client init');
    edit();
    key(field()!, 'Enter');
    expect(renames).toEqual([]);
  });

  it('clears the person’s own title, handing naming back to Claude', () => {
    render({ id: 'r', title: 'Mine', titleSource: 'person' });
    key(shown()!, 'Enter');
    expect(field()!.placeholder).toBe('Clear to let Claude name it');
    type('');
    key(field()!, 'Enter');
    expect(renames).toEqual([['r', '']]);
  });

  it('saves when the field loses focus', () => {
    render({ id: 'r', title: 'Sentry client init', titleSource: 'ai' });
    edit();
    type('Blurred name');
    act(() => field()!.blur());
    expect(renames).toEqual([['r', 'Blurred name']]);
  });
});
