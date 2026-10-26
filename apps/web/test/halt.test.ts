import { describe, expect, it } from 'vitest';
import { haltLine, haltNote, type KelpieEvent } from '@kelpie/protocol';
import { STATUS_LABEL, type AgentSummary } from '../src/lib/agents.js';
import { buildChat } from '../src/lib/chat.js';
import { haltState, resumeLabel } from '../src/lib/halt.js';
import { planBar, planLabel } from '../src/lib/plan.js';
import { roundUpSummary, statusLine, type RoundUp } from '../src/lib/round-ups.js';
import { GROUP_LABEL, planGroup, roundUpStatus, sessionStatus } from '../src/lib/status.js';

const r = (over: Partial<RoundUp>): RoundUp => ({ id: 'top', title: '', cwd: '/r', createdAt: 0, updatedAt: 100, busy: false, mode: 'auto', ...over });
const agent = (over: Partial<AgentSummary>): AgentSummary => ({
  id: 'a',
  parentId: 'top',
  title: 'API',
  harness: 'claude-code',
  writes: true,
  browser: false,
  status: 'working',
  now: '',
  todos: [],
  createdAt: 0,
  updatedAt: 50,
  ...over,
});
const ev = (kind: string, data: unknown, i = 0) => ({ id: `${kind}-${i}`, runId: 'r', seq: i, ts: '2026-10-27T10:00:00.000Z', harness: 'claude-code', kind, data }) as unknown as KelpieEvent;

describe('stopped by the person', () => {
  it('is its own status and group, "Stopped by you", apart from failed, paused and an interrupted turn', () => {
    expect(STATUS_LABEL.halted).toBe('Stopped by you');
    expect(GROUP_LABEL.halted).toBe('Stopped by you');
    expect(planGroup(agent({ status: 'halted' }))).toBe('halted');
    expect(planGroup(agent({ status: 'stopped' }))).toBe('stopped');
    expect(planLabel(agent({ status: 'halted' }))).toBe('Stopped by you');
    // A session's status (the sidebar's sub-agents) works it out the same way; working again wins.
    expect(sessionStatus({ busy: false, halted: 1, lastTurn: 'interrupted' }, false)).toBe('halted');
    expect(sessionStatus({ busy: true, halted: 1 }, false)).toBe('working');
  });

  it("is the round-up's dot over what is done or ready to merge, never over work or the person's attention", () => {
    const halted = r({ halted: 90, lastTurn: 'interrupted' });
    expect(roundUpStatus(halted, [], [])).toBe('halted');
    expect(roundUpStatus(r({ lastTurn: 'completed' }), [r({ id: 's', parentId: 'top', halted: 90, lastTurn: 'interrupted', updatedAt: 50 })], [])).toBe('halted');
    expect(roundUpStatus(halted, [r({ id: 's', parentId: 'top', busy: true })], [])).toBe('working');
    expect(roundUpStatus(halted, [], [{ roundUpId: 'top' }])).toBe('needs-you');
  });

  it('says so under the title and in the Plan bar', () => {
    expect(statusLine(r({ halted: Date.now() - 1000 }), Date.now()).text).toBe('Stopped by you · just now');
    const stopped = [agent({ id: 'a', status: 'halted' }), agent({ id: 'b', status: 'halted' }), agent({ id: 'c', status: 'done', branch: undefined })];
    expect(roundUpSummary(r({ halted: 90 }), stopped, 1000)).toBe('2 stopped by you');
    const bar = planBar(stopped);
    expect(bar.text).toBe('2 agents are stopped by you');
    expect(bar.dots.map((d) => d.group)).toEqual(['halted', 'halted']);
    expect(planBar([agent({ status: 'halted' })]).text).toBe('API is stopped by you');
    // Anything still moving leads.
    expect(planBar([...stopped, agent({ id: 'd', title: 'Docs', status: 'working' })]).text).toBe('Docs: Working');
  });

  it('offers Stop all while agents work, asking first when more than one would stop, and Resume all while stopped', () => {
    expect(haltState(r({}), [agent({})])).toMatchObject({ canStop: true, confirm: false, halted: false });
    expect(haltState(r({ busy: true }), [agent({})])).toMatchObject({ canStop: true, confirm: true });
    expect(haltState(r({}), [agent({ id: 'a' }), agent({ id: 'b', status: 'needs-approval' })])).toMatchObject({ stoppable: 2, confirm: true });
    // Paused at the usage limit with Kelpie due to resume it: Stop all stops that too.
    expect(haltState(r({}), [agent({ status: 'paused', limited: { since: 0, retryAt: 10, attempts: 0, message: '' } })]).stoppable).toBe(1);
    expect(haltState(r({}), [agent({ status: 'done' })])).toMatchObject({ canStop: false, halted: false });
    // One resumed but still in line for a slot is stopped again too.
    expect(haltState(r({}), [agent({}), agent({ id: 'b', status: 'stopped', queued: true })]).stoppable).toBe(2);
    expect(haltState(r({ halted: 5 }), [agent({ status: 'halted' }), agent({ id: 'b', status: 'halted' })])).toMatchObject({ canStop: false, halted: true, resumable: 2 });
    expect(resumeLabel(3)).toBe('Resume all (3)');
    expect(resumeLabel(0)).toBe('Resume');
    // Resumed, but in line for a slot under the agent limit.
    expect(planLabel(agent({ status: 'stopped', queued: true }))).toBe('Waiting for a slot');
  });

  it('shows in the chat as one line each way, and keeps Kelpie\'s notes to the orchestrator out of it', () => {
    const items = buildChat([
      ev('message', { role: 'user', text: `Why did it stop?\n\n${haltNote([{ agentId: 'a', title: 'API' }])}`, sent: true, source: 'user' }, 0),
      ev('halt', { action: 'stopped', agents: 3, orchestrator: true }, 1),
      ev('message', { role: 'user', text: '<kelpie-notification>\nThe person resumed this round-up\n</kelpie-notification>', sent: true, source: 'kelpie', resumed: 'halt' }, 2),
      ev('halt', { action: 'resumed', agents: 3 }, 3),
    ]);
    expect(items[0]).toMatchObject({ role: 'user', text: 'Why did it stop?' });
    expect(items[1]).toMatchObject({
      role: 'assistant',
      parts: [
        { type: 'halt', action: 'stopped', text: 'You stopped 3 agents and Kelpie' },
        { type: 'halt', action: 'resumed', text: 'You resumed 3 agents' },
      ],
    });
    expect(haltLine({ action: 'stopped', agents: 1 })).toBe('You stopped 1 agent');
  });
});
