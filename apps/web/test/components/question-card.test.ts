// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Question } from '@kelpie/protocol';
import { QuestionCard, type QuestionCardProps } from '../../src/components/chat/question-card.js';

// React only runs effects inside `act` when it is told it is under test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const color: Question = { question: 'Docs asks: Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] };
const size: Question = { question: 'Which size?', header: 'Size', options: [{ label: 'S' }, { label: 'L' }] };

let root: Root;
let host: HTMLDivElement;
let posted: unknown[];
let request = 0;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  posted = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ results: [{ ok: true }] }), { headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function render(questions: Question[], extra: Partial<QuestionCardProps> = {}) {
  const props: QuestionCardProps = { questions, state: 'open', sessionId: 's1', requestId: `q${request++}`, who: 'Kelpie', relayFrom: ['Docs', 'API'], ...extra };
  act(() => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(QuestionCard, props))));
}
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
const click = async (el: HTMLElement) => act(async () => el.click());

describe('QuestionCard', () => {
  it("names the agent a passed-on question is from, and shows the question without it", () => {
    render([color]);
    expect(host.querySelector('header')?.textContent).toContain('Docs needs a call');
    expect(host.textContent).toContain('Which color?');
    expect(host.textContent).not.toContain('Docs asks:');
  });

  it('answers "You decide" with its button', async () => {
    render([color]);
    await click(button('You decide'));
    expect(posted).toEqual([{ items: [{ sessionId: 's1', requestId: expect.any(String) }], decision: 'allow', answers: { 'Docs asks: Which color?': 'You decide' } }]);
  });

  it('leaves "You decide" once the person picks an option after all', async () => {
    render([color, size]);
    await click(button('You decide'));
    // On to the next question; back to the first, it shows as decided.
    await click(host.querySelectorAll<HTMLElement>('[role="tab"]')[0]!);
    expect(button('You decide').getAttribute('aria-pressed')).toBe('true');
    await click(button('Red'));
    expect(button('You decide').getAttribute('aria-pressed')).toBe('false');
    expect(button('Red').getAttribute('aria-checked')).toBe('true');
  });

  it('keeps "You decide" written in Other as the person\'s own words, box and all', async () => {
    render([color, size]);
    await click(button('Other…'));
    const box = host.querySelector<HTMLInputElement>('input[aria-label="Your own answer"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, 'You decide');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Your own answer"]')?.value).toBe('You decide');
    expect(button('Other…').getAttribute('aria-checked')).toBe('true');
    expect(button('You decide').getAttribute('aria-pressed')).toBe('false');
  });
});
