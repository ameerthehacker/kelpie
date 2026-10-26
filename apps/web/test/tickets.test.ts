import { describe, expect, it } from 'vitest';
import type { LinkedTicket } from '@kelpie/protocol';
import { ticketsDisplay, ticketView } from '../src/lib/tickets.js';

const jira = (key: string, over: Partial<LinkedTicket> = {}): LinkedTicket => ({
  provider: 'jira',
  kind: 'issue',
  url: `https://acme.atlassian.net/browse/${key}`,
  key,
  source: 'auto',
  addedAt: 1,
  ...over,
});
const asana = (over: Partial<LinkedTicket> = {}): LinkedTicket => ({ provider: 'asana', kind: 'project', url: 'https://app.asana.com/0/1201/list', source: 'orchestrator', addedAt: 2, ...over });

describe('ticket views', () => {
  it('shows a Jira issue by its key in mono, with its title as detail', () => {
    expect(ticketView(jira('PLAT-88'))).toEqual({
      id: 'https://acme.atlassian.net/browse/PLAT-88',
      label: 'PLAT-88',
      mono: true,
      provider: 'Jira',
      detail: undefined,
      href: 'https://acme.atlassian.net/browse/PLAT-88',
      aria: 'PLAT-88, Jira (opens in a new tab)',
    });
    expect(ticketView(jira('SHOP-412', { title: 'Guest checkout API' }))).toMatchObject({ label: 'SHOP-412', detail: 'Guest checkout API', aria: 'SHOP-412: Guest checkout API, Jira (opens in a new tab)' });
  });

  it('shows an Asana link by its title, or as what it is until one is known', () => {
    expect(ticketView(asana({ title: 'Q4 checkout launch' }))).toMatchObject({ label: 'Q4 checkout launch', mono: false, provider: 'Asana', detail: undefined });
    expect(ticketView(asana())).toMatchObject({ label: 'Asana project' });
    expect(ticketView(asana({ kind: 'task', url: 'https://app.asana.com/0/0/1209' }))).toMatchObject({ label: 'Asana task' });
  });

  it('never links anything but a web page', () => {
    expect(ticketView(jira('X-1', { url: 'javascript:alert(1)' })).href).toBeUndefined();
    expect(ticketView(jira('X-1', { url: 'not a url' })).href).toBeUndefined();
  });

  it('shows nothing, one chip, or an "N tickets" list in linked order', () => {
    expect(ticketsDisplay(undefined)).toEqual({ kind: 'none' });
    expect(ticketsDisplay([])).toEqual({ kind: 'none' });
    expect(ticketsDisplay([jira('PLAT-88')])).toMatchObject({ kind: 'one', ticket: { label: 'PLAT-88' } });
    const many = ticketsDisplay([jira('SHOP-412'), jira('SHOP-420'), asana({ title: 'Q4 checkout launch' })]);
    expect(many.kind === 'many' && [many.label, many.tickets.map((t) => `${t.label} ${t.provider}`)]).toEqual([
      '3 tickets',
      ['SHOP-412 Jira', 'SHOP-420 Jira', 'Q4 checkout launch Asana'],
    ]);
  });
});
