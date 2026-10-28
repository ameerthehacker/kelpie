import type { Question } from '@kelpie/protocol';

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
  /** Questions it puts to the person (AskUserQuestion): answered, not allowed. */
  questions?: Question[];
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

/** Questions are answered one by one (each has its own answers), in the chat or from the queue. */
export const isQuestion = (a: PendingApproval) => !!a.questions?.length;

/** Requests one allow or deny settles: not plans or questions. */
export const isAsk = (a: PendingApproval) => !isPlan(a) && !isQuestion(a);

/** The questions waiting, oldest first. */
export const pendingQuestions = (items: readonly PendingApproval[]) => items.filter(isQuestion).sort((x, y) => x.ts.localeCompare(y.ts));

/** A question in the queue, as the tray tells them apart: whose it is and which request. */
export const questionKey = (q: Pick<PendingApproval, 'sessionId' | 'requestId'>) => `${q.sessionId}:${q.requestId}`;

/** Which queued question the tray shows: the one the person paged to while it waits, else the oldest. */
export function shownQuestion(questions: readonly PendingApproval[], picked: string | undefined): number {
  return Math.max(0, questions.findIndex((q) => questionKey(q) === picked));
}

/**
 * Where the keyboard goes when the question that had it leaves the queue (answered, skipped, or
 * answered elsewhere): to the question shown next, else to the approvals, else nowhere ('none':
 * the tray is gone). Undefined while that question still waits, or if none had the keyboard.
 */
export function focusAfter(
  questions: readonly PendingApproval[],
  focused: string | undefined,
  shown: number,
  approvals: number,
): { question: string } | 'approvals' | 'none' | undefined {
  if (!focused || questions.some((q) => questionKey(q) === focused)) return undefined;
  const next = questions[shown];
  if (next) return { question: questionKey(next) };
  return approvals ? 'approvals' : 'none';
}

/**
 * Groups identical requests, so ten agents wanting `pnpm install` are one row: the same rule and
 * the same exact ask. Never by rule alone, since a broad rule (`Bash(npm run:*)`) covers different
 * commands, and one click must not allow a command the row doesn't show. Oldest group first.
 */
export function groupApprovals(items: readonly PendingApproval[]): ApprovalGroup[] {
  const groups = new Map<string, ApprovalGroup>();
  for (const a of [...items].filter(isAsk).sort((x, y) => x.ts.localeCompare(y.ts))) {
    const key = [a.roundUpId, a.tool, a.rule ?? '', a.title].join('\u0000');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, tool: a.tool, label: a.title || a.tool, rule: a.rule, items: [], agents: [] }));
    g.items.push(a);
    if (!g.agents.includes(a.agentTitle)) g.agents.push(a.agentTitle);
  }
  return [...groups.values()];
}

/**
 * Whether "Allow for round-up" is offered: there is a rule to save, and an agent is asking. Saved rules
 * are for the round-up's agents only, so the orchestrator's own requests are allowed once each.
 */
export const canRemember = (g: Pick<ApprovalGroup, 'rule' | 'items'>) => !!g.rule && g.items.some((a) => a.sessionId !== a.roundUpId);

/** The rule "Allow for round-up" would save, when it allows more than the row shows (`Bash(npm run:*)` for `npm run test`). */
export function broaderRule(g: Pick<ApprovalGroup, 'tool' | 'label' | 'rule'>): string | undefined {
  return g.rule && g.rule !== `${g.tool}(${g.label})` ? g.rule : undefined;
}

/**
 * What "Allow for round-up" allows, in words: an MCP tool's rule is that one tool of its server
 * (`every guide call to claude_ai_Claude_Docs`), anything else its rule as written.
 */
export function ruleLabel(rule: string): string {
  const [mcp, server, ...tool] = rule.split('__');
  return mcp === 'mcp' && server && tool.length ? `every ${tool.join('__')} call to ${server}` : rule;
}

/** "3 approvals from 2 agents", "1 question" (one agent goes without saying), "2 approvals and 1 question from 3 agents". */
export function approvalsSummary(items: readonly PendingApproval[]): string {
  const asks = items.filter(isAsk);
  const questions = items.filter(isQuestion);
  const counted = [...asks, ...questions];
  const agents = new Set(counted.map((a) => a.sessionId)).size;
  const parts = [
    asks.length && `${asks.length} approval${asks.length === 1 ? '' : 's'}`,
    questions.length && `${questions.length} question${questions.length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return agents > 1 ? `${parts.join(' and ')} from ${agents} agents` : parts.join(' and ');
}
