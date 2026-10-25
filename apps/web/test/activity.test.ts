import { describe, expect, it } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import { nameList, orchestratorStatus, toolStatus } from '../src/lib/activity.js';

const ev = (kind: string, data: unknown, parentCallId?: string) => ({ kind, data, parentCallId }) as unknown as KelpieEvent;
const busy = (b: boolean) => ev('activity', { busy: b });
const kelpie = (name: string) => `mcp__kelpie__${name}`;
const started = (callId: string, name: string, input: unknown = {}, category = name.startsWith('mcp__') ? 'mcp' : 'other', parentCallId?: string) =>
  ev('tool.started', { callId, name, category, title: 'raw title', input }, parentCallId);
const finished = (callId: string) => ev('tool.finished', { callId, name: 'x', ok: true, output: '', truncated: false });
const said = (text: string) => ev('message', { role: 'assistant', text });
const thought = ev('thinking', { text: '', redacted: true });
const agents = [
  { id: 'a1', title: 'Fix: notifications' },
  { id: 'a2', title: 'Review: docs' },
  { id: 'a3', title: 'Fix: todo resume' },
];
// The end of an earlier turn that finished with a reply.
const before = [busy(true), said('All done.'), ev('turn.ended', { status: 'completed' }), busy(false)];

describe('orchestratorStatus', () => {
  it('says it is thinking as soon as a turn starts, before anything is echoed', () => {
    expect(orchestratorStatus([...before, busy(true)], agents)).toBe('Thinking…');
    // A message the person just sent, not yet in the log.
    expect(orchestratorStatus(before, agents)).toBe('Thinking…');
  });

  it('names the agents a notification reports on, by their current titles', () => {
    const note = ev('message', {
      role: 'user',
      text: '<kelpie-notification>…',
      sent: true,
      source: 'kelpie',
      agents: [
        { agentId: 'a1', title: 'old title', status: 'completed' },
        { agentId: 'a2', title: 'Review: docs', status: 'completed' },
      ],
    });
    expect(orchestratorStatus([...before, busy(true), note], agents)).toBe('Reading reports from Fix: notifications and Review: docs');
    const one = ev('message', { role: 'user', text: '…', source: 'kelpie', agents: [{ agentId: 'gone', title: 'Old agent', status: 'completed' }] });
    expect(orchestratorStatus([busy(true), one], agents)).toBe('Reading the report from Old agent');
  });

  it('reads agents out of an older notification that only has the text', () => {
    const text = '<kelpie-notification>\n## Agent "Fix: notifications" (a1) is idle: turn completed\nAll good.\n</kelpie-notification>';
    expect(orchestratorStatus([busy(true), ev('message', { role: 'user', text, sent: true })], [])).toBe('Reading the report from Fix: notifications');
  });

  it('thinks after the person speaks and after a thinking block', () => {
    expect(orchestratorStatus([busy(true), ev('message', { role: 'user', text: 'hi', source: 'user' })], agents)).toBe('Thinking…');
    expect(orchestratorStatus([busy(true), thought], agents)).toBe('Thinking…');
  });

  it('is writing a reply once text has come in mid-turn', () => {
    expect(orchestratorStatus([busy(true), thought, said('Both are done.')], agents)).toBe('Writing a reply…');
  });

  it('describes the tool running now', () => {
    expect(orchestratorStatus([busy(true), thought, started('c1', kelpie('read_agent'), { agentId: 'a1' })], agents)).toBe("Reading Fix: notifications's report");
    expect(orchestratorStatus([busy(true), said('Merging.'), started('c1', kelpie('muster_agents'), { agentIds: ['a1', 'a3'] })], agents)).toBe('Merging 2 branches');
  });

  it('folds calls running side by side into one line', () => {
    const reads = [started('c1', kelpie('read_agent'), { agentId: 'a1' }), started('c2', kelpie('read_agent'), { agentId: 'a2' })];
    expect(orchestratorStatus([busy(true), thought, ...reads], agents)).toBe('Reading reports from Fix: notifications and Review: docs');
    // One answered: only the other is still being read.
    expect(orchestratorStatus([busy(true), thought, ...reads, finished('c1')], agents)).toBe("Reading Review: docs's report");
    const spawns = ['A', 'B', 'C'].map((t, i) => started(`s${i}`, kelpie('spawn_agent'), { title: t }));
    expect(orchestratorStatus([busy(true), ...spawns], agents)).toBe('Starting 3 agents');
    expect(orchestratorStatus([busy(true), ...spawns.slice(0, 2)], agents)).toBe('Starting A and B');
  });

  it('goes over reports once they are in, and thinks after other tools', () => {
    const read = [started('c1', kelpie('read_agent'), { agentId: 'a1' }), finished('c1')];
    expect(orchestratorStatus([busy(true), thought, ...read], agents)).toBe("Going over Fix: notifications's report");
    expect(orchestratorStatus([busy(true), thought, started('c1', 'Read', { file_path: '/r/a.ts' }, 'read'), finished('c1')], agents)).toBe('Thinking…');
  });

  it('ignores what sub-agents spawned by a tool do', () => {
    const events = [busy(true), started('t1', 'Task', { description: 'look' }, 'task'), started('c9', 'Bash', { command: 'sed -n 1,2p x' }, 'bash', 't1')];
    expect(orchestratorStatus(events, agents)).toBe('Running a sub-agent');
  });

  it('waits on the person while a permission request is open', () => {
    const asked = ev('permission.requested', { requestId: 'r1', tool: 'Bash', title: 'x', input: {} });
    expect(orchestratorStatus([busy(true), started('c1', 'Bash', {}, 'bash'), asked], agents)).toBe('Waiting for your approval');
    const answered = ev('permission.resolved', { requestId: 'r1', decision: 'allow', by: 'person' });
    expect(orchestratorStatus([busy(true), started('c1', 'Bash', {}, 'bash'), asked, answered], agents)).toBe('Running a command');
  });

  it('only looks at the turn in progress', () => {
    const earlier = [busy(true), started('c1', kelpie('list_agents')), ev('process.exited', { code: 1, signal: null, stderrTail: '' })];
    expect(orchestratorStatus([...earlier, busy(true)], agents)).toBe('Thinking…');
  });
});

describe('toolStatus', () => {
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.title;
  const call = (name: string, input: unknown = {}, category = 'mcp') => toolStatus({ name, category, input } as Parameters<typeof toolStatus>[0], nameOf);

  it("words Kelpie's tools with agent titles, never ids", () => {
    expect(call(kelpie('spawn_agent'), { title: 'Orchestrator status indicator' })).toBe('Starting Orchestrator status indicator');
    expect(call(kelpie('message_agent'), { agentId: 'a3', text: '…' })).toBe('Messaging Fix: todo resume');
    expect(call(kelpie('list_agents'))).toBe('Checking agents');
    expect(call(kelpie('read_agent'), { agentId: 'a2', detail: 'log' })).toBe("Reading Review: docs's log");
    expect(call(kelpie('read_agent'), { agentId: 'nope' })).toBe("Reading an agent's report");
    expect(call(kelpie('muster_agents'), { agentIds: ['a1'] })).toBe("Merging Fix: notifications's branch");
    expect(call(kelpie('interrupt_agent'), { agentId: 'a1' })).toBe('Pausing Fix: notifications');
  });

  it('words harness tools without their raw arguments', () => {
    expect(call('Read', { file_path: '/repo/packages/daemon/src/orchestrator/orchestrator.ts' }, 'read')).toBe('Reading orchestrator.ts');
    expect(call('Grep', { pattern: 'foo.*bar' }, 'search')).toBe('Searching the repo');
    expect(call('Glob', { pattern: '**/*.ts' }, 'search')).toBe('Looking for files');
    expect(call('Bash', { command: 'sed -n 820,890p x.ts' }, 'bash')).toBe('Running a command');
    expect(call('Edit', { file_path: '/r/a.tsx' }, 'edit')).toBe('Editing a.tsx');
    expect(call('WebFetch', { url: 'https://example.com/x' }, 'web')).toBe('Reading example.com');
    expect(call('WebSearch', { query: 'x' }, 'web')).toBe('Searching the web');
    expect(call('TodoWrite', {}, 'todo')).toBe('Updating the plan');
    expect(call('mcp__github__get_issue', {}, 'mcp')).toBe('Using github');
    expect(call('Mystery', {}, 'other')).toBe('Working…');
  });
});

describe('nameList', () => {
  it('lists up to two names, then counts the rest', () => {
    expect(nameList(['A'])).toBe('A');
    expect(nameList(['A', 'B'])).toBe('A and B');
    expect(nameList(['A', 'B', 'C', 'D'])).toBe('A, B and 2 more');
    expect(nameList(['A', 'A'])).toBe('A');
  });
});
