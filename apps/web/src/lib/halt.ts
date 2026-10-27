import type { AgentSummary } from './agents.js';
import type { RoundUp } from './round-ups.js';

/** What "Stop all" and "Resume all" offer for a round-up, from its agents and its own state. Pure. */
export interface HaltState {
  /** Agents "Stop all" would stop: working, waiting on the person, in line for a slot, or due to resume after the usage limit. */
  stoppable: number;
  /** Whether "Stop all" has anything to stop: those agents, or the orchestrator's own turn. */
  canStop: boolean;
  /** Stop all asks first: more than one agent would stop. */
  confirm: boolean;
  /** The orchestrator's own turn is running, so Stop all would stop it too. */
  kelpieWorking: boolean;
  /** The person has the round-up stopped: "Resume all" shows. */
  halted: boolean;
  /** Agents it would resume. */
  resumable: number;
}

export function haltState(roundUp: Pick<RoundUp, 'busy' | 'halted'> | undefined, agents: readonly Pick<AgentSummary, 'status' | 'limited' | 'queued'>[]): HaltState {
  const stoppable = agents.filter((a) => a.status === 'working' || a.status === 'needs-approval' || (a.queued && a.status !== 'halted') || (a.status === 'paused' && !!a.limited?.retryAt)).length;
  const resumable = agents.filter((a) => a.status === 'halted').length;
  return {
    stoppable,
    // The orchestrator's own turn alone is the composer's stop button.
    canStop: stoppable > 0,
    confirm: stoppable + (roundUp?.busy ? 1 : 0) > 1,
    kelpieWorking: !!roundUp?.busy,
    halted: !!roundUp?.halted || resumable > 0,
    resumable,
  };
}

/** "Resume all (3)", or with nothing of its agents to resume, "Resume": the orchestrator may work again. */
export const resumeLabel = (n: number) => (n ? `Resume all (${n})` : 'Resume');
