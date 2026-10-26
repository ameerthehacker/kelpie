import { describe, expect, it } from 'vitest';
import type { LinkedTicket } from '@kelpie/protocol';
import { ticketPaste, ticketView } from '../src/lib/tickets.js';

const jira = (key: string, over: Partial<LinkedTicket> = {}): LinkedTicket => ({
  provider: 'jira',
  kind: 'issue',
  ref: `jira:acme.atlassian.net/${key}`,
  url: `https://acme.atlassian.net/browse/${key}`,
  key,
  source: 'auto',
  addedAt: 1,
  ...over,
});
const asana = (over: Partial<LinkedTicket> = {}): LinkedTicket => ({ ref: 'asana:project:1201', provider: 'asana', kind: 'project', url: 'https://app.asana.com/0/1201/list', source: 'orchestrator', addedAt: 2, ...over });

describe('ticket views', () => {
  it('shows a Jira issue by its key in mono, with its title as detail', () => {
    expect(ticketView(jira('PLAT-88'))).toEqual({
      id: 'https://acme.atlassian.net/browse/PLAT-88',
      ref: 'jira:acme.atlassian.net/PLAT-88',
      title: '',
      label: 'PLAT-88',
      mono: true,
      provider: 'Jira',
      detail: undefined,
      href: 'https://acme.atlassian.net/browse/PLAT-88',
      aria: 'PLAT-88, Jira (opens in a new tab)',
    });
    expect(ticketView(jira('SHOP-412', { title: 'Guest checkout API' }))).toMatchObject({ label: 'SHOP-412', detail: 'Guest checkout API', aria: 'SHOP-412: Guest checkout API, Jira (opens in a new tab)' });
  });

  it('shows an Asana link by its title, or as what it is with the end of its id until one is known', () => {
    expect(ticketView(asana({ title: 'Q4 checkout launch' }))).toMatchObject({ label: 'Q4 checkout launch', title: 'Q4 checkout launch', mono: false, provider: 'Asana', detail: undefined });
    expect(ticketView(asana())).toMatchObject({ label: 'Asana project …1201', title: '' });
    expect(ticketView(asana({ kind: 'task', url: 'https://app.asana.com/0/0/1209874821' }))).toMatchObject({ label: 'Asana task …4821' });
  });

  it('has nothing to rename on a Workbench card', () => {
    const { ref: _, source: __, addedAt: ___, ...card } = jira('X-1');
    expect(ticketView(card).ref).toBeUndefined();
  });

  it('never links anything but a web page', () => {
    expect(ticketView(jira('X-1', { url: 'javascript:alert(1)' })).href).toBeUndefined();
    expect(ticketView(jira('X-1', { url: 'not a url' })).href).toBeUndefined();
  });
});

describe('ticketPaste', () => {
  const task = 'https://app.asana.com/0/1201/1209';
  it('writes a rich copy’s ticket links as [name](url)', () => {
    // Rich apps copy the link's text only: the address comes from the HTML.
    expect(ticketPaste('Fix Checkout flake today', [{ href: task, text: 'Checkout flake' }])).toBe(`Fix [Checkout flake](${task}) today`);
    expect(ticketPaste(`See ${task}`, [{ href: task, text: ' Checkout\n flake ' }])).toBe(`See [Checkout flake](${task})`);
  });

  it('leaves other links, bare addresses and markdown alone', () => {
    expect(ticketPaste('Read the docs', [{ href: 'https://example.com/docs', text: 'the docs' }])).toBe('Read the docs');
    expect(ticketPaste(task, [{ href: task, text: task }])).toBe(task);
    expect(ticketPaste(`[Flake](${task})`, [{ href: task, text: 'Flake' }])).toBe(`[Flake](${task})`);
    expect(ticketPaste('nothing here', [{ href: task, text: 'Checkout flake' }])).toBe('nothing here');
  });

  it('matches whole words and whole links only, never inside a link it wrote, and keeps $ as typed', () => {
    const other = 'https://app.asana.com/0/1201/1300';
    expect(ticketPaste('Payments, then Pay', [{ href: task, text: 'Pay' }])).toBe(`Payments, then [Pay](${task})`);
    expect(ticketPaste(`See ${task}0 and ${task}`, [{ href: task, text: 'Flake' }])).toBe(`See ${task}0 and [Flake](${task})`);
    expect(ticketPaste('Checkout flake, and flake', [{ href: task, text: 'Checkout flake' }, { href: other, text: 'flake' }])).toBe(
      `[Checkout flake](${task}), and [flake](${other})`,
    );
    expect(ticketPaste('Cost $& more', [{ href: task, text: 'Cost $&' }])).toBe(`[Cost $&](${task}) more`);
  });
});
