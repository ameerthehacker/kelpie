/** How a round-up's orchestrator hears that the person stopped its agents, and that they resumed them. */

const TAG = 'kelpie-notification';
const STOP_LEAD = 'The person stopped all your agents';

const agents = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;

/**
 * Goes with the orchestrator's next turn (the person's own included) after "Stop all": once. The UI
 * leaves it out of the person's message (stripHaltNote).
 */
export function haltNote(stopped: { agentId: string; title: string }[]): string {
  const which = stopped.length ? ` (${stopped.map((a) => `"${a.title}" (${a.agentId})`).join(', ')})` : '';
  return `<${TAG}>\n${STOP_LEAD}${which}${stopped.length ? '' : ' (none was working)'}, and your own turn if it was running. Until they resume them in Kelpie, spawn_agent, message_agent, muster_agents and assign_threads are refused: don't retry them, respawn or work around it. Answer what the person asks you with what you already know, and leave resuming to them.\n\nThis message is from Kelpie, not the person.\n</${TAG}>`;
}

/** Only the note exactly as haltNote writes it, at the end of a turn. */
const HALT_NOTE = new RegExp(`\\n*<${TAG}>\\n${STOP_LEAD}[^]*?\\n</${TAG}>$`);

/** A turn's text without Kelpie's note that the person stopped all agents. */
export const stripHaltNote = (text: string): string => text.replace(HALT_NOTE, '');

/** Whether a turn carried that note. */
export const hasHaltNote = (text: string): boolean => text.includes(`<${TAG}>\n${STOP_LEAD}`);

/**
 * What the orchestrator is sent once the person resumes what they stopped: it wakes it too. `queued`
 * of them wait for a free slot first, `paused` for the usage limit to reset.
 */
export function haltResumed(resumed: { agentId: string; title: string }[], queued: number, paused = 0): string {
  const some = (n: number) => (n === resumed.length ? 'They' : `${n} of them`);
  const waits = `${queued ? ` ${some(queued)} wait for a free slot under the agent limit first.` : ''}${paused ? ` ${some(paused)} wait for the usage limit to reset first.` : ''}`;
  const list = resumed.length
    ? ` They resumed ${agents(resumed.length)}, which continue where they left off: ${resumed.map((a) => `"${a.title}" (${a.agentId})`).join(', ')}.${waits} You will be notified when they finish, as usual; don't message or respawn them.`
    : '';
  return `<${TAG}>\nThe person resumed this round-up after stopping all agents: you may start and message agents again.${list} If your own turn was stopped, continue where you left off.\n\nThis message is from Kelpie, not the person.\n</${TAG}>`;
}

/** What a sub-agent stopped by the person is sent when they resume it. */
export const AGENT_HALT_RESUMED = 'You were stopped by the person; continue where you left off, and end with your report.';

/** "You stopped 3 agents", "You resumed 1 agent": the round-up's chat line for a Halt event. */
export function haltLine(h: { action: 'stopped' | 'resumed'; agents: number; orchestrator?: boolean | undefined }): string {
  if (h.action === 'resumed') return h.agents ? `You resumed ${agents(h.agents)}` : 'You resumed this round-up';
  if (!h.agents) return h.orchestrator ? 'You stopped Kelpie' : 'You stopped all agents';
  return `You stopped ${agents(h.agents)}${h.orchestrator ? ' and Kelpie' : ''}`;
}
