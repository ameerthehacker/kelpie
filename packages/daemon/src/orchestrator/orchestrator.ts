import { randomBytes } from 'node:crypto';
import { CLAUDE_DEFAULT_TOOLS as DEFAULT_TOOLS, type RunSpec } from '@kelpie/adapters';
import { Harness, type KelpieEvent } from '@kelpie/protocol';
import type { Store } from '@kelpie/store';
import type { RunContext, Session, SessionHooks, SessionManager } from '../sessions.js';
import { logLines, report, type AgentReport, type LogPage } from './digest.js';
import { AGENT_RESTARTED, NOTIFICATION_TAG, ORCHESTRATOR_PROMPT, ORCHESTRATOR_RESTARTED, agentPrompt, freshPreface } from './prompt.js';

/** The orchestrator's only built-in tools: its todo list. Everything else is the kelpie MCP server. */
export const ORCHESTRATOR_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
export const READ_ONLY_TOOLS = DEFAULT_TOOLS.filter((t) => !EDIT_TOOLS.has(t));

const REPORT_CHARS = 2000;

/** A refusal the orchestrator should read and act on (not a Kelpie bug). */
export class ToolError extends Error {}

export interface OrchestratorOptions {
  store: Store;
  /** Where harnesses reach the kelpie MCP server, e.g. http://127.0.0.1:7317/mcp. */
  mcpUrl: string;
  /** Sub-agents one orchestrator may have working at once. */
  maxAgents?: number;
  /** Idles within this window go to the orchestrator as one notification. */
  notifyDelayMs?: number;
}

export interface AgentInfo {
  agentId: string;
  title: string;
  harness: string;
  writes: boolean;
  status: 'working' | 'idle' | 'waiting';
  lastTurn: string | undefined;
  updatedAt: string;
  costUsd: number;
}

export interface SpawnInput {
  title: string;
  task: string;
  writes: boolean;
  harness?: string | undefined;
  model?: string | undefined;
}

/**
 * Turns round-ups into orchestrators over sub-agent round-ups. Owns what is not in the
 * database because it can be rebuilt: bearer tokens, debounce timers, and the queue of
 * sub-agents waiting to be resumed after a restart.
 */
export class Orchestrator implements SessionHooks {
  private sessions: SessionManager | undefined;
  private readonly store: Store;
  private readonly mcpUrl: string;
  readonly maxAgents: number;
  private readonly notifyDelayMs: number;
  /** Bearer token → orchestrator round-up id, one per orchestrator process. */
  private readonly tokens = new Map<string, string>();
  private readonly tokenOfRun = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Each orchestrator's notifications go out one at a time, so two never cover the same idle. */
  private readonly flushes = new Map<string, Promise<void>>();
  /** Sub-agents to resume after a restart once the cap or the writer guard lets them. */
  private readonly waiting = new Set<string>();
  /**
   * Sub-agents a tool call has cleared to start but whose turn is not sent yet (sending can
   * wait for a process that is stopping). They count as working, so no second call slips past
   * the cap or the writer guard in that gap.
   */
  private readonly reserved = new Set<string>();

  constructor(opts: OrchestratorOptions) {
    this.store = opts.store;
    this.mcpUrl = opts.mcpUrl;
    this.maxAgents = opts.maxAgents ?? 4;
    this.notifyDelayMs = opts.notifyDelayMs ?? 1500;
  }

  attach(sessions: SessionManager): void {
    this.sessions = sessions;
  }

  private get manager(): SessionManager {
    if (!this.sessions) throw new Error('orchestrator is not attached to a session manager');
    return this.sessions;
  }

  // ── hooks ────────────────────────────────────────────────────────────

  specFor(session: Session, run: RunContext): Partial<RunSpec> {
    const preface = run.fresh && run.hadHistory ? freshPreface(session.role, this.store.firstSent(session.id)?.text) : '';
    if (session.role === 'agent') {
      return {
        tools: session.writes ? DEFAULT_TOOLS : READ_ONLY_TOOLS,
        allowedTools: ['Bash'],
        appendSystemPrompt: agentPrompt(session.writes) + preface,
      };
    }
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(token, session.id);
    this.tokenOfRun.set(run.runId, token);
    const mcp = { mcpServers: { kelpie: { type: 'http', url: this.mcpUrl, headers: { Authorization: `Bearer ${token}` } } } };
    return {
      tools: ORCHESTRATOR_TOOLS,
      allowedTools: ['mcp__kelpie'],
      mcpConfig: [JSON.stringify(mcp)],
      appendSystemPrompt: ORCHESTRATOR_PROMPT + preface,
    };
  }

  observe(session: Session, _index: number, event: KelpieEvent): void {
    if (event.kind === 'process.exited') {
      const token = this.tokenOfRun.get(event.runId);
      if (token) this.tokens.delete(token);
      this.tokenOfRun.delete(event.runId);
    }
    if (event.kind === 'activity' && !event.data.busy && session.role === 'agent') {
      if (session.parentId) this.schedule(session.parentId);
      // A slot or the repo may have freed up for an agent waiting to resume.
      if (this.waiting.size) this.resumeWaiting();
    }
  }

  /** The orchestrator round-up a bearer token belongs to, while its process runs. */
  authorize(token: string | undefined): Session | undefined {
    const id = token ? this.tokens.get(token) : undefined;
    return id ? this.manager.get(id) : undefined;
  }

  // ── tools ────────────────────────────────────────────────────────────

  async spawn(parent: Session, input: SpawnInput): Promise<{ agentId: string; status: string }> {
    const harness = Harness.safeParse(input.harness ?? 'claude-code');
    if (!harness.success) throw new ToolError(`unknown harness "${input.harness}"; available: ${Harness.options.join(', ')}`);
    if (!input.task.trim()) throw new ToolError('task is empty: give the agent a complete brief');
    this.checkCap(parent);
    if (input.writes) this.checkWriter(parent.cwd);
    const child = this.manager.create(parent.cwd, {
      parentId: parent.id,
      role: 'agent',
      writes: input.writes,
      // One line: it heads notifications and the UI.
      title: input.title.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Agent',
      ...(input.model ? { model: input.model } : {}),
    });
    await this.reserving(child, () => child.send(input.task, 'orchestrator'));
    return { agentId: child.id, status: 'working' };
  }

  list(parent: Session): AgentInfo[] {
    return this.manager.children(parent.id).map((c) => this.agentInfo(c));
  }

  read(parent: Session, agentId: string, detail: 'report' | 'log' = 'report', after?: number, limit?: number): (AgentInfo & AgentReport) | (AgentInfo & LogPage) {
    const child = this.child(parent, agentId);
    const events = child.events();
    const info = this.agentInfo(child);
    return detail === 'log' ? { ...info, ...logLines(events, after, limit) } : { ...info, ...report(events) };
  }

  async message(parent: Session, agentId: string, text: string): Promise<{ status: string }> {
    const child = this.child(parent, agentId);
    if (!text.trim()) throw new ToolError('text is empty');
    if (!this.isWorking(child)) {
      this.checkCap(parent);
      if (child.writes) this.checkWriter(child.cwd, child.id);
    }
    // A message picks up an agent still waiting to resume after a restart: no restart turn later.
    this.waiting.delete(child.id);
    child.clearResumePending();
    await this.reserving(child, () => child.send(text, 'orchestrator'));
    return { status: 'working' };
  }

  async interrupt(parent: Session, agentId: string): Promise<{ status: string }> {
    const child = this.child(parent, agentId);
    await child.interrupt();
    return { status: child.working ? 'working' : 'idle' };
  }

  // ── recovery ─────────────────────────────────────────────────────────

  /**
   * After a daemon start: resumes every round-up that was working when Kelpie stopped
   * (sub-agents first, as the cap and writer guard allow), and sends each orchestrator the
   * notifications it was still owed.
   */
  async recover(): Promise<void> {
    // Also anything with turns it never took in (e.g. killed in the instant after a send).
    const pending = this.manager.all().filter((s) => s.resumePending || this.store.undelivered(s.id).length > 0);
    for (const agent of pending.filter((s) => s.role === 'agent')) this.waiting.add(agent.id);
    await this.resumeWaiting();
    await Promise.all(pending.filter((s) => s.role === 'orchestrator').map((s) => s.resumeAfterRestart(ORCHESTRATOR_RESTARTED)));
    const parents = new Set(this.manager.all().flatMap((s) => (s.parentId ? [s.parentId] : [])));
    for (const id of parents) this.schedule(id);
  }

  private async resumeWaiting(): Promise<void> {
    for (const id of [...this.waiting]) {
      const agent = this.manager.get(id);
      const parent = agent?.parentId ? this.manager.get(agent.parentId) : undefined;
      if (!agent || !parent) {
        this.waiting.delete(id);
        continue;
      }
      if (this.working(parent) >= this.maxAgents) continue;
      if (agent.writes && this.busyWriter(agent.cwd, agent.id)) continue;
      this.waiting.delete(id);
      try {
        await agent.resumeAfterRestart(AGENT_RESTARTED);
      } catch (err) {
        console.error(`agent ${id}: could not resume`, err);
      }
    }
  }

  // ── notifications ────────────────────────────────────────────────────

  private schedule(parentId: string): void {
    if (this.timers.has(parentId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(parentId);
      const next = (this.flushes.get(parentId) ?? Promise.resolve())
        .then(() => this.flush(parentId))
        // Refused while Kelpie shuts down: the next start sends it (it goes by notifiedIdx).
        .catch((err) => console.error(`orchestrator ${parentId}: notification not sent:`, (err as Error).message));
      this.flushes.set(parentId, next);
      void next.finally(() => this.flushes.get(parentId) === next && this.flushes.delete(parentId));
    }, this.notifyDelayMs);
    timer.unref();
    this.timers.set(parentId, timer);
  }

  /** Tells the orchestrator about every sub-agent that went idle since it was last told. */
  private async flush(parentId: string): Promise<void> {
    const parent = this.manager.get(parentId);
    if (!parent) return;
    const owed = this.manager.children(parentId).flatMap((c) => {
      if (this.isWorking(c) || this.waiting.has(c.id)) return [];
      const idle = this.store.lastEventAt(c.id, 'activity');
      return idle && !idle.event.data.busy && idle.index > c.notifiedIdx ? [{ agent: c, index: idle.index }] : [];
    });
    if (!owed.length) return;
    const text = notification(owed.map(({ agent }) => ({ agent, report: report(agent.events()) })));
    // Sent and marked in one transaction: after a crash it is neither lost nor sent twice.
    await parent.send(text, 'kelpie', () => owed.forEach(({ agent, index }) => agent.markNotified(index)));
  }

  // ── rules ────────────────────────────────────────────────────────────

  private isWorking(s: Session): boolean {
    return s.working || this.reserved.has(s.id);
  }

  private working(parent: Session): number {
    return this.manager.children(parent.id).filter((c) => this.isWorking(c)).length;
  }

  private async reserving(child: Session, send: () => Promise<void>): Promise<void> {
    this.reserved.add(child.id);
    try {
      await send();
    } finally {
      this.reserved.delete(child.id);
    }
  }

  private checkCap(parent: Session): void {
    if (this.working(parent) >= this.maxAgents) {
      throw new ToolError(
        `${this.maxAgents} agents are already working, the most allowed at once. End your turn; you will be notified as they finish.`,
      );
    }
  }

  private busyWriter(cwd: string, except?: string): Session | undefined {
    return this.manager.all().find((s) => s.role === 'agent' && s.writes && s.cwd === cwd && s.id !== except && this.isWorking(s));
  }

  private checkWriter(cwd: string, except?: string): void {
    const writer = this.busyWriter(cwd, except);
    if (writer) {
      throw new ToolError(
        `writing agent "${writer.title}" is still working in this repo, and only one writer may work at a time. Read-only agents can still run. End your turn; you will be notified when it finishes.`,
      );
    }
  }

  private child(parent: Session, agentId: string): Session {
    const child = this.manager.get(agentId);
    if (!child || child.parentId !== parent.id) throw new ToolError(`no such agent: ${agentId}`);
    return child;
  }

  private agentInfo(c: Session): AgentInfo {
    const info = c.info();
    return {
      agentId: c.id,
      title: c.title,
      harness: info.harness,
      writes: c.writes,
      status: this.isWorking(c) ? 'working' : this.waiting.has(c.id) ? 'waiting' : 'idle',
      lastTurn: c.lastTurn,
      updatedAt: new Date(info.updatedAt).toISOString(),
      costUsd: Math.round(this.store.costOf(c.id) * 10_000) / 10_000,
    };
  }
}

function notification(items: { agent: Session; report: AgentReport }[]): string {
  const body = items.map(({ agent, report: r }) => {
    const text = r.report.length > REPORT_CHARS ? `${r.report.slice(0, REPORT_CHARS)}…\n(report cut; read_agent has all of it)` : r.report;
    const files = r.filesChanged.length ? `\nFiles changed: ${r.filesChanged.map((f) => `${f.path} (+${f.added} -${f.removed})`).join(', ')}` : '';
    const error = r.error ? `\nError: ${r.error}` : '';
    return `## Agent "${agent.title}" (${agent.id}) is idle: turn ${r.lastTurn ?? 'not started'}${error}${files}\n\n${text || '(no report)'}`;
  });
  return `<${NOTIFICATION_TAG}>\n${body.join('\n\n')}\n\nThis message is from Kelpie, not the person. Use read_agent for more detail.\n</${NOTIFICATION_TAG}>`;
}
