/** A harness waiting on the person (mirrors the daemon's `PendingApproval`). */
export interface PendingApproval {
  roundUpId: string;
  sessionId: string;
  agentTitle: string;
  requestId: string;
  tool: string;
  title: string;
  input: unknown;
  rule?: string;
  plan?: string;
  ts: string;
}

/** Requests for the same thing (one permission rule), from however many agents. */
export interface ApprovalGroup {
  key: string;
  tool: string;
  /** What is asked, in a line: a command, a path, a URL. */
  label: string;
  /** The rule that allows it; "Allow for round-up" saves it. */
  rule: string | undefined;
  items: PendingApproval[];
  /** The agents asking, each once, in the order they asked. */
  agents: string[];
}

export interface SavedRule {
  id: number;
  rule: string;
  createdAt: number;
}

/** Plans are put to the person in the chat, one at a time; everything else queues. */
export const isPlan = (a: PendingApproval) => a.tool === 'ExitPlanMode';

/**
 * Groups identical requests, so ten agents wanting `pnpm install` are one row: the same rule and
 * the same exact ask. Never by rule alone, since a broad rule (`Bash(npm run:*)`) covers different
 * commands, and one click must not allow a command the row doesn't show. Oldest group first.
 */
export function groupApprovals(items: readonly PendingApproval[]): ApprovalGroup[] {
  const groups = new Map<string, ApprovalGroup>();
  for (const a of [...items].filter((x) => !isPlan(x)).sort((x, y) => x.ts.localeCompare(y.ts))) {
    const key = [a.roundUpId, a.tool, a.rule ?? '', a.title].join('\u0000');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, tool: a.tool, label: a.title || a.tool, rule: a.rule, items: [], agents: [] }));
    g.items.push(a);
    if (!g.agents.includes(a.agentTitle)) g.agents.push(a.agentTitle);
  }
  return [...groups.values()];
}

/** The rule "Allow for round-up" would save, when it allows more than the row shows (`Bash(npm run:*)` for `npm run test`). */
export function broaderRule(g: Pick<ApprovalGroup, 'tool' | 'label' | 'rule'>): string | undefined {
  return g.rule && g.rule !== `${g.tool}(${g.label})` ? g.rule : undefined;
}

/** "3 approvals from 2 agents". */
export function approvalsSummary(items: readonly PendingApproval[]): string {
  const asks = items.filter((a) => !isPlan(a));
  const agents = new Set(asks.map((a) => a.sessionId)).size;
  return `${asks.length} approval${asks.length === 1 ? '' : 's'} from ${agents} agent${agents === 1 ? '' : 's'}`;
}
