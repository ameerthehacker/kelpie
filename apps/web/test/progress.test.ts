import { describe, expect, it } from 'vitest';
import type { AgentUpdate } from '@kelpie/protocol';
import type { AgentSummary } from '../src/lib/agents.js';
import type { ChatItem } from '../src/lib/chat.js';
import { chatProgress, changeStat, progressOf, progressState } from '../src/lib/progress.js';

let n = 0;
const agent = (status: AgentSummary['status'], extra: Partial<AgentSummary> = {}): AgentSummary => {
  n++;
  return { id: `a${n}`, parentId: 'p', title: `Agent ${n}`, harness: 'claude-code', writes: false, browser: false, status, now: '', todos: [], createdAt: n, updatedAt: n, ...extra };
};
const update = (agentId: string, extra: Partial<AgentUpdate> = {}): AgentUpdate => ({ agentId, title: agentId, status: 'completed', ...extra });

describe('progressState', () => {
  it('marks agents as the design does, with failed and stopped kept apart', () => {
    const states = [
      agent('done'),
      agent('done', { writes: true, branch: 'b', worktree: 'active' }),
      agent('needs-approval'),
      agent('working'),
      agent('idle'),
      agent('paused'),
      agent('stopped', { queued: true }),
      agent('failed'),
      agent('stopped'),
      agent('halted'),
    ].map(progressState);
    expect(states).toEqual(['done', 'done', 'needs-you', 'working', 'queued', 'queued', 'queued', 'failed', 'stopped', 'stopped']);
  });
});

describe('progressOf', () => {
  it('counts what is done, with a segment per agent in the order they started', () => {
    const agents = [agent('working', { title: 'B', createdAt: 2 }), agent('done', { title: 'A', createdAt: 1 }), agent('idle', { title: 'C', createdAt: 3 })];
    const p = progressOf(agents);
    expect([p.done, p.total]).toEqual([1, 3]);
    expect(p.segments).toEqual([
      { state: 'done', size: 1, title: 'A' },
      { state: 'working', size: 1, title: 'B' },
      { state: 'queued', size: 1, title: 'C' },
    ]);
  });

  it('folds the bar into a run per state past its cap', () => {
    const agents = [...Array.from({ length: 5 }, () => agent('done')), agent('needs-approval'), ...Array.from({ length: 3 }, () => agent('working'))];
    expect(progressOf(agents, new Map(), 4).segments).toEqual([
      { state: 'done', size: 5 },
      { state: 'needs-you', size: 1 },
      { state: 'working', size: 3 },
    ]);
  });

  it('says who is still working, naming two at most, and what else is left', () => {
    const one = progressOf([agent('working', { title: 'Guest checkout UI' }), agent('idle'), agent('idle'), agent('done')]);
    expect(one.footer).toEqual({ text: 'Guest checkout UI is still working · 2 queued', tone: 'working' });
    const two = progressOf([agent('working', { title: 'A' }), agent('working', { title: 'B' })]);
    expect(two.footer.text).toBe('A and B are still working');
    const many = progressOf([agent('working', { title: 'A' }), agent('working', { title: 'B' }), agent('working'), agent('working'), agent('needs-approval'), agent('failed')]);
    expect(many.footer.text).toBe('A, B, and 2 others are still working · 1 needs you · 1 failed');
  });

  it('says when everything has finished, and keeps a failure in view', () => {
    const all = progressOf([agent('done'), agent('done')]);
    expect([all.finished, all.footer]).toEqual([true, { text: 'All agents finished', tone: 'done' }]);
    const failed = progressOf([agent('done'), agent('failed')]);
    expect([failed.finished, failed.footer]).toEqual([true, { text: 'Nothing left working · 1 failed', tone: 'failed' }]);
    const waiting = progressOf([agent('done'), agent('needs-approval')]);
    expect([waiting.finished, waiting.footer]).toEqual([false, { text: '1 needs you', tone: 'needs-you' }]);
  });

  it('lists finished work newest first: a writer’s changes with its stat, a report by its first line', () => {
    const writer = agent('done', { title: 'Guest form', writes: true, branch: 'b', worktree: 'active', updatedAt: 50 });
    const merged = agent('done', { title: 'Schema', writes: true, branch: 'c', worktree: 'mustered', updatedAt: 10 });
    const reader = agent('done', { title: 'Survey', updatedAt: 30 });
    const updates = new Map([
      [writer.id, update(writer.id, { filesChanged: [{ path: 'a', added: 6, removed: 1 }, { path: 'b', added: 1, removed: 0 }] })],
      [reader.id, update(reader.id, { report: '## Outcome\nall good' })],
    ]);
    const p = progressOf([writer, merged, reader, agent('working', { updatedAt: 1 })], updates);
    expect(p.ready).toEqual([
      { agentId: writer.id, title: 'Guest form', harness: 'claude-code', kind: 'changes', detail: '+7 −1 · 2 files', state: 'review', at: 50 },
      { agentId: reader.id, title: 'Survey', harness: 'claude-code', kind: 'report', detail: 'all good', state: 'done', at: 30 },
      { agentId: merged.id, title: 'Schema', harness: 'claude-code', kind: 'changes', state: 'merged', at: 10 },
    ]);
    expect(p.lastChange).toBe(50);
  });
});

describe('changeStat', () => {
  it('sums the lines and counts the files', () => {
    expect(changeStat([{ path: 'a', added: 3, removed: 2 }])).toBe('+3 −2 · 1 file');
    expect(changeStat([])).toBeUndefined();
    expect(changeStat(undefined)).toBeUndefined();
  });
});

describe('chatProgress', () => {
  it('puts the card in the latest reply that started agents or heard from them, with each agent’s latest report', () => {
    const items: ChatItem[] = [
      { role: 'user', id: 'u1', text: 'go' },
      { role: 'assistant', id: 'r1', parts: [{ type: 'spawn', callId: 'c1', title: 'A', state: 'done', agentId: 'a' }] },
      { role: 'assistant', id: 'r2', parts: [{ type: 'agents', agents: [update('a', { report: 'first' })], ts: '' }] },
      { role: 'assistant', id: 'r3', parts: [{ type: 'agents', agents: [update('a', { report: 'second' })], ts: '' }] },
      { role: 'assistant', id: 'r4', parts: [{ type: 'spawn', callId: 'c2', title: 'B', state: 'error' }, { type: 'text', text: 'ok', ts: '' }] },
    ];
    const p = chatProgress(items);
    expect(p.anchor).toBe('r3');
    expect(p.updates.get('a')?.report).toBe('second');
  });

  it('has no place for it without agents', () => {
    expect(chatProgress([{ role: 'assistant', id: 'r', parts: [{ type: 'text', text: 'hi', ts: '' }] }]).anchor).toBeUndefined();
  });
});
