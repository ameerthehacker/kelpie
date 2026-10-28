/**
 * Questions the orchestrator passes on from one of its agents: it starts each with the agent's
 * exact title and "asks:", "Checkout API asks: Where should guest orders live?", so Kelpie can
 * show the question as that agent's call.
 */
const ASKS = ' asks: ';

/** A question passed on from `agent`, worded as the orchestrator is told to. */
export const relayQuestion = (agent: string, question: string) => `${agent}${ASKS}${question}`;

/**
 * The agent a question was passed on from, among `titles` (the round-up's agents); undefined for
 * the orchestrator's own. Longest title first, so "Checkout API" wins over "API"; an ordinary
 * question that happens to say "asks:" is left alone.
 */
export function relaySender(question: string, titles: readonly string[]): string | undefined {
  const q = question.toLowerCase();
  return [...titles].sort((a, b) => b.length - a.length).find((t) => q.startsWith(`${t.toLowerCase()}${ASKS}`));
}

/** A question's words without the "<agent> asks: " it was passed on with. */
export const unrelayed = (question: string, from: string | undefined) =>
  from && question.toLowerCase().startsWith(`${from.toLowerCase()}${ASKS}`) ? question.slice(from.length + ASKS.length) : question;
