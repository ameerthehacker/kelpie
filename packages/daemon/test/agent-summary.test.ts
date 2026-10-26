import { describe, expect, it } from 'vitest';
import type { KelpieEvent } from '@kelpie/protocol';
import { nowOf } from '../src/agent-summary.js';

const ev = (kind: string, data: unknown, parentCallId?: string) => ({ kind, data, parentCallId }) as unknown as KelpieEvent;

describe('nowOf', () => {
  it('names the tool behind a tool call, so clients need not parse the line', () => {
    expect(nowOf(ev('tool.started', { callId: 'c', name: 'Read', category: 'read', title: 'src/a.ts', input: {} }))).toEqual({
      now: 'Read src/a.ts',
      nowTool: { name: 'Read', category: 'read' },
    });
  });

  it('has no tool for what the agent said, even when it starts like one', () => {
    expect(nowOf(ev('message', { role: 'assistant', text: 'Task done.\nMore.' }))).toEqual({ now: 'Task done.' });
    expect(nowOf(ev('turn.ended', { status: 'interrupted' }))).toEqual({ now: 'Stopped.' });
  });

  it('skips todos, sub-agent chatter and anything else', () => {
    expect(nowOf(ev('tool.started', { callId: 'c', name: 'TodoWrite', category: 'todo', title: '', input: {} }))).toBeUndefined();
    expect(nowOf(ev('tool.started', { callId: 'c', name: 'Read', category: 'read', title: 'x', input: {} }, 'parent'))).toBeUndefined();
    expect(nowOf(ev('turn.ended', { status: 'completed' }))).toBeUndefined();
    expect(nowOf(ev('message', { role: 'user', text: 'hi' }))).toBeUndefined();
  });
});
