import { describe, expect, it } from 'vitest';
import { findTickets, parseTicketUrl, ticketLabel } from '../src/index.js';

describe('parseTicketUrl', () => {
  it('reads a Jira issue page', () => {
    expect(parseTicketUrl('https://acme.atlassian.net/browse/PLAT-88')).toEqual({
      provider: 'jira',
      kind: 'issue',
      url: 'https://acme.atlassian.net/browse/PLAT-88',
      key: 'PLAT-88',
      ref: 'jira:acme.atlassian.net/PLAT-88',
    });
  });

  it('opens Jira board and project links as the issue page, so each issue is one ticket', () => {
    const forms = [
      'https://acme.atlassian.net/browse/SHOP-412?focusedCommentId=10',
      'https://acme.atlassian.net/jira/software/projects/SHOP/boards/3?selectedIssue=SHOP-412',
      'https://acme.atlassian.net/jira/software/c/projects/SHOP/issues/SHOP-412',
      'https://acme.atlassian.net/jira/core/projects/SHOP/issues/SHOP-412?filter=all',
      'https://acme.atlassian.net/issues/?jql=project%3DSHOP&selectedIssue=SHOP-412',
      'https://ACME.atlassian.net/browse/shop-412#comment',
    ];
    for (const f of forms) {
      expect(parseTicketUrl(f), f).toMatchObject({ key: 'SHOP-412', url: 'https://acme.atlassian.net/browse/SHOP-412', ref: 'jira:acme.atlassian.net/SHOP-412' });
    }
  });

  it('keeps a Jira Server path prefix', () => {
    expect(parseTicketUrl('https://jira.corp.example/tracker/browse/OPS-7')).toMatchObject({ key: 'OPS-7', url: 'https://jira.corp.example/tracker/browse/OPS-7' });
  });

  it('ignores Jira links that are not an issue', () => {
    expect(parseTicketUrl('https://acme.atlassian.net/jira/software/projects/SHOP/boards/3')).toBeUndefined();
    expect(parseTicketUrl('https://acme.atlassian.net/wiki/spaces/ENG/pages/1')).toBeUndefined();
    expect(parseTicketUrl('https://acme.atlassian.net/browse/not-a-key')).toBeUndefined();
    expect(parseTicketUrl('https://example.com/browse/SHOP-1')).toBeUndefined();
  });

  it('reads classic Asana task and project links', () => {
    expect(parseTicketUrl('https://app.asana.com/0/1201/1209/f')).toEqual({
      provider: 'asana',
      kind: 'task',
      url: 'https://app.asana.com/0/1201/1209/f',
      ref: 'asana:task:1209',
    });
    expect(parseTicketUrl('https://app.asana.com/0/0/1209')).toMatchObject({ kind: 'task', ref: 'asana:task:1209' });
    expect(parseTicketUrl('https://app.asana.com/0/1201/list')).toMatchObject({ kind: 'project', ref: 'asana:project:1201' });
    expect(parseTicketUrl('https://app.asana.com/0/1201')).toMatchObject({ kind: 'project', ref: 'asana:project:1201' });
  });

  it('reads newer Asana links', () => {
    expect(parseTicketUrl('https://app.asana.com/1/77/project/1201/task/1209?focus=true')).toMatchObject({
      kind: 'task',
      ref: 'asana:task:1209',
      url: 'https://app.asana.com/1/77/project/1201/task/1209?focus=true',
    });
    expect(parseTicketUrl('https://app.asana.com/1/77/task/1209')).toMatchObject({ kind: 'task', ref: 'asana:task:1209' });
    expect(parseTicketUrl('https://app.asana.com/1/77/project/1201/list/88')).toMatchObject({ kind: 'project', ref: 'asana:project:1201' });
  });

  it('ignores other Asana pages and other sites', () => {
    for (const u of [
      'https://app.asana.com/0/inbox/77',
      'https://app.asana.com/0/home/77',
      'https://app.asana.com/0/search/1/2',
      'https://app.asana.com/1/77/inbox/5/item/9/story/3',
      'https://app.asana.com/1/77/home',
      'https://asana.com/0/1201/1209',
      'https://github.com/acme/monorepo/issues/12',
      'ftp://acme.atlassian.net/browse/A-1',
      'not a url',
    ]) {
      expect(parseTicketUrl(u), u).toBeUndefined();
    }
  });
});

describe('findTickets', () => {
  it('finds every ticket linked in a message, first mention first, each once', () => {
    const text = `Ship guest checkout (see https://acme.atlassian.net/browse/SHOP-412, and
https://acme.atlassian.net/jira/software/projects/SHOP/boards/3?selectedIssue=SHOP-420). Project: <https://app.asana.com/0/1201/list>.
Again: [SHOP-412](https://acme.atlassian.net/browse/SHOP-412). Also **https://app.asana.com/0/1201/1209**.`;
    expect(findTickets(text).map((t) => t.ref)).toEqual([
      'jira:acme.atlassian.net/SHOP-412',
      'jira:acme.atlassian.net/SHOP-420',
      'asana:project:1201',
      'asana:task:1209',
    ]);
  });

  it('leaves bare keys and other links alone', () => {
    expect(findTickets('Fix SHOP-412 and see https://github.com/acme/web/pull/3')).toEqual([]);
  });
});

describe('ticketLabel', () => {
  it('names a ticket by key, then title, then what it is', () => {
    expect(ticketLabel({ provider: 'jira', kind: 'issue', key: 'PLAT-88', title: 'Node 22' })).toBe('PLAT-88');
    expect(ticketLabel({ provider: 'asana', kind: 'project', title: 'Q4 checkout launch' })).toBe('Q4 checkout launch');
    expect(ticketLabel({ provider: 'asana', kind: 'task' })).toBe('Asana task');
    expect(ticketLabel({ provider: 'asana', kind: 'project' })).toBe('Asana project');
  });
});
