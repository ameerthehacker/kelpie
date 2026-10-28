import { describe, expect, it } from 'vitest';
import { orchestratorPrompt } from '../src/orchestrator/prompt.js';

describe('the delegate orchestrator prompt', () => {
  it('is the text from before delegation levels', () => {
    expect(orchestratorPrompt()).toMatchSnapshot();
    expect(orchestratorPrompt('/tmp/scratch', 'plan', 3)).toMatchSnapshot();
    expect(orchestratorPrompt('/s', 'acceptEdits', 8)).toMatchSnapshot();
  });
});
