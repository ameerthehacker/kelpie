/// <reference lib="dom" />
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSteady } from '../src/hooks/use-steady.js';

// React only runs effects inside `act` when it is told it is under test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
const shown: string[] = [];

function Probe({ value, minMs }: { value: string; minMs: number }) {
  shown.push(useSteady(value, minMs));
  return null;
}

const render = (value: string, minMs = 1000) => act(() => root.render(createElement(Probe, { value, minMs })));
const latest = () => shown.at(-1);
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('useSteady', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    shown.length = 0;
    root = createRoot(document.createElement('div'));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it('shows the first value at once', () => {
    render('Thinking…');
    expect(latest()).toBe('Thinking…');
  });

  it('keeps each value up for at least minMs, then shows the latest', () => {
    render('a');
    render('b');
    expect(latest()).toBe('a');
    wait(999);
    expect(latest()).toBe('a');
    wait(1);
    expect(latest()).toBe('b');
  });

  it('skips values that came and went in between', () => {
    render('a');
    wait(200);
    render('b');
    wait(200);
    render('c');
    wait(599);
    expect(latest()).toBe('a');
    wait(1);
    expect(latest()).toBe('c');
    expect(shown).not.toContain('b');
  });

  it('changes at once when the last change is older than minMs', () => {
    render('a');
    wait(5000);
    render('b');
    wait(0);
    expect(latest()).toBe('b');
  });

  it('counts the wait from when the shown value went up', () => {
    render('a');
    wait(1500);
    render('b');
    wait(0);
    render('c');
    wait(999);
    expect(latest()).toBe('b');
    wait(1);
    expect(latest()).toBe('c');
  });

  it('drops a pending change that is taken back', () => {
    render('a');
    render('b');
    render('a');
    wait(2000);
    expect(shown.every((s) => s === 'a')).toBe(true);
  });

  it('leaves no timer behind when unmounted', () => {
    render('a');
    render('b');
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(document.createElement('div'));
  });
});
