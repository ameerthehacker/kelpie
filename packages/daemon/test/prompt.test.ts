import { describe, expect, it } from 'vitest';
import { orchestratorPrompt } from '../src/orchestrator/prompt.js';

const solo = orchestratorPrompt({ scratch: '/tmp/scratch', delegation: 'solo' });
const balanced = orchestratorPrompt({ scratch: '/tmp/scratch', delegation: 'balanced' });
const delegate = orchestratorPrompt({ scratch: '/tmp/scratch', delegation: 'delegate' });

describe('the delegate orchestrator prompt', () => {
  it('is the text from before delegation levels', () => {
    expect(orchestratorPrompt({ delegation: 'delegate' })).toMatchSnapshot();
    expect(orchestratorPrompt({ scratch: '/tmp/scratch', mode: 'plan', maxAgents: 3, delegation: 'delegate' })).toMatchSnapshot();
    expect(orchestratorPrompt({ scratch: '/s', mode: 'acceptEdits', maxAgents: 8, delegation: 'delegate' })).toMatchSnapshot();
  });

  it('is what the positional form, which predates levels, still gives', () => {
    expect(orchestratorPrompt('/tmp/scratch', 'auto', 4)).toBe(orchestratorPrompt({ scratch: '/tmp/scratch', maxAgents: 4, delegation: 'delegate' }));
  });

  it('has no feature-checkout tools', () => {
    expect(delegate).toContain('You never do the work yourself.');
    expect(delegate).not.toContain('open_feature_checkout');
  });
});

describe('the orchestrator prompt by delegation level', () => {
  it('defaults to balanced', () => {
    expect(orchestratorPrompt({ scratch: '/tmp/scratch' })).toBe(balanced);
    expect(orchestratorPrompt()).toBe(orchestratorPrompt({ delegation: 'balanced' }));
  });

  it.each([['solo', solo], ['balanced', balanced]])('%s explains working in the feature checkout', (_, prompt) => {
    expect(prompt).toContain('Call open_feature_checkout first to get its path');
    expect(prompt).toContain('use Edit, Write and Bash there');
    expect(prompt).toContain('Kelpie commits the edits you leave in the feature checkout at the end of each turn, and before it spawns a writer or musters');
    expect(prompt).toContain('Never edit or run commands while a Muster agent is working in the feature checkout');
    expect(prompt).toContain('Your commands run in the feature checkout: Kelpie starts each one there unless your shell is already inside it');
    expect(prompt).toContain("it refuses any command that names the person's checkout");
    expect(prompt).toContain('Threads in the "No agent" group are on your own edits: fix those yourself');
    expect(prompt).not.toContain('Kelpie starts a "Review fixes" writer');
    expect(prompt).not.toContain('You never do the work yourself');
    expect(prompt).not.toContain('Write and Edit work only inside your scratch folder');
    expect(prompt).toContain('TaskCreate');
  });

  it('solo works itself and leaves out the rules for running agents', () => {
    expect(solo).toContain('You do their work yourself');
    expect(solo).toContain('Do not spawn sub-agents');
    for (const delegating of ['run them in parallel', 'deliver:', 'Lower the effort', 'browser: true', 'maxAgents', 'muster_agents', 'Do not poll']) {
      expect(solo).not.toContain(delegating);
    }
  });

  it('solo keeps the rules that still apply', () => {
    for (const kept of ['link_ticket', 'create_card', 'workbench_read', 'reply_to_thread', 'resolve_thread', 'AskUserQuestion', 'set_base_branch', 'If tests fail or you skipped a step, say so plainly']) {
      expect(solo).toContain(kept);
    }
  });

  it('solo is much shorter than delegate', () => {
    expect(solo.length).toBeLessThan(delegate.length * 0.6);
    expect(solo.length).toBeLessThan(balanced.length);
  });

  it('balanced says when to work itself and when to spawn', () => {
    expect(balanced).toContain('Do it yourself when it is small, quick and sequential');
    expect(balanced).toContain('Spawn an agent when the unit is big');
    expect(balanced).toContain('needs the browser');
    expect(balanced).toContain('run them in parallel');
    expect(balanced).toContain('browser: true');
    expect(balanced).toContain('muster_agents');
  });

  it.each([['solo', 'your file edits go through freely'], ['balanced', 'you and your agents change files freely'], ['delegate', 'agents change files freely']] as const)(
    '%s explains accept-edits mode for who edits',
    (delegation, text) => {
      expect(orchestratorPrompt({ mode: 'acceptEdits', delegation })).toContain(text);
    },
  );

  it('solo plan mode does not mention agents', () => {
    const plan = orchestratorPrompt({ mode: 'plan', delegation: 'solo' });
    expect(plan).toContain('not even in the feature checkout');
    expect(plan).not.toContain('read-only agents');
  });
});
