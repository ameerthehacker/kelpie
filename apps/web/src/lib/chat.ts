import { questionsOf, stripAttachments, type AgentUpdate, type Answers, type Attachment, type EventOf, type KelpieEvent, type Question, type TodoItem, type ToolCategory } from '@kelpie/protocol';

export interface ToolView {
  type: 'tool';
  callId: string;
  name: string;
  category: ToolCategory;
  title: string;
  input: unknown;
  state: 'running' | 'done' | 'error';
  output?: string;
  delta?: { added: number; removed: number };
  /** One-line summaries of what a sub-agent spawned by this call did. */
  steps: string[];
  /** When it started (ISO). */
  ts: string;
}

export type AssistantPart =
  | { type: 'text'; text: string; ts: string }
  | { type: 'reasoning'; text: string; ts: string }
  | ToolView
  /** A sub-agent the orchestrator started (or tried to). */
  | SpawnView
  /** Sub-agents Kelpie told the orchestrator about. */
  | { type: 'agents'; agents: AgentUpdate[]; ts: string }
  /** `link`: where the notice leads (the round-up's Changes tab, for a review). */
  | { type: 'notice'; tone: 'error' | 'info'; text: string; ts: string; link?: 'changes' }
  /** A plan put to the person (ExitPlanMode), and what became of it. */
  | PlanView
  /** Questions put to the person (AskUserQuestion), and their answers. */
  | QuestionView;

export interface QuestionView {
  type: 'question';
  /** The AskUserQuestion call. */
  callId?: string;
  /** Known once it is put to the person. */
  requestId?: string;
  questions: Question[];
  /**
   * `asking`: called, not yet put to the person; `open`: waiting for them; then answered, skipped by
   * them, refused by Kelpie, or no longer waiting (the run ended).
   */
  state: 'asking' | 'open' | 'answered' | 'skipped' | 'refused' | 'expired';
  answers?: Answers;
  ts: string;
}

export interface PlanView {
  type: 'plan';
  requestId: string;
  plan: string;
  state: 'open' | 'approved' | 'declined' | 'expired';
  /** The person's note, when they sent it back. */
  message?: string;
  ts: string;
}

export interface SpawnView {
  type: 'spawn';
  callId: string;
  title: string;
  state: 'running' | 'done' | 'error';
  /** Known once the call returns. */
  agentId?: string;
  /** Why it was refused. */
  error?: string;
}

const SPAWN_TOOL = 'mcp__kelpie__spawn_agent';
const ASK_TOOL = 'AskUserQuestion';

/** Who sent a turn: the person, the orchestrator (to its sub-agent), or Kelpie. */
export type Sender = NonNullable<EventOf<'message'>['data']['source']>;

export type ChatItem =
  /** `text` without the `<attachments>` block; the files are in `attachments`. */
  | { role: 'user'; id: string; text: string; ts?: string; source?: Sender; attachments?: Attachment[] }
  | { role: 'assistant'; id: string; parts: AssistantPart[] };

const NOTIFICATION_OPEN = '<kelpie-notification>';
const AGENT_HEADER = /^## Agent "(.*)" \(([^)]*)\) is idle: turn (.+)$/gm;

/**
 * The agents in a notification's text. Only for logs written before echoes carried
 * `agents` (and `source`); the daemon now attaches both.
 */
export function agentsFromText(text: string): AgentUpdate[] {
  const body = text
    .replace(/\n*This message is from Kelpie[^]*$/, '')
    .replace(/\n*<\/kelpie-notification>\s*$/, '')
    .replace(MUSTERED, '');
  const headers = [...body.matchAll(AGENT_HEADER)];
  return headers.map((m, i) => {
    const end = headers[i + 1]?.index ?? body.length;
    let rest = body.slice(m.index + m[0].length, end).replace(/^\n/, '');
    let error: string | undefined;
    for (;;) {
      const line = /^(Error|Files changed|Branch|Review threads): (.*)\n?/.exec(rest);
      if (!line) break;
      if (line[1] === 'Error') error = line[2];
      rest = rest.slice(line[0].length);
    }
    const report = rest.trim().replace(/\n?\(report cut; read_agent has all of it\)$/, '');
    return { agentId: m[2]!, title: m[1]!, status: m[3]!.trim(), report: report === '(no report)' ? '' : report, ...(error ? { error } : {}) };
  });
}

/** What a review notification's echo carries (`Message.review`). */
interface ReviewMeta {
  reviewId: string;
  verdict: 'comment' | 'request_changes' | 'approve';
  comments: number;
  threads: number;
  /** Threads made on an agent's own Changes tab, sent straight to it. */
  direct?: { agentId: string; title: string; threads: number }[];
}

const VERDICT: Record<ReviewMeta['verdict'], string> = { comment: 'Comment', request_changes: 'Request changes', approve: 'Approve' };

/** "You submitted a review · Request changes · 3 comments · 2 sent to API, 1 to Docs". */
export function reviewNotice(r: Pick<ReviewMeta, 'verdict' | 'comments' | 'direct'>): string {
  const parts = ['You submitted a review', VERDICT[r.verdict] ?? r.verdict];
  if (r.comments) parts.push(`${r.comments} comment${r.comments === 1 ? '' : 's'}`);
  if (r.direct?.length) parts.push(r.direct.map((d, i) => `${d.threads} ${i ? 'to' : 'sent to'} ${d.title}`).join(', '));
  return parts.join(' · ');
}

/** The line a notification ends with after Muster: what git says is in the feature branch now. */
const MUSTERED = /\n*In the feature branch now \(checked with git\): (.*?)\.(?: Still not mustered: (.*?)\.)?(?=\n|$)/;

/**
 * A turn Kelpie sent the orchestrator itself: agent updates (and, after Muster, what reached the
 * feature branch), or a note (a restart) as one line. The echo's `agents` leave out a report the
 * text already carries in full.
 */
function kelpieTurn(data: EventOf<'message'>['data'], ts: string): AssistantPart[] {
  // A review the person submitted, on its way to the orchestrator.
  const review = (data as { review?: ReviewMeta }).review;
  if (review) return [{ type: 'notice', tone: 'info', text: reviewNotice(review), ts, link: 'changes' }];
  const parsed = agentsFromText(data.text);
  const agents = data.agents?.map((a) => ({ ...a, report: a.report ?? parsed.find((p) => p.agentId === a.agentId)?.report ?? '' })) ?? parsed;
  if (agents.length) {
    const m = MUSTERED.exec(data.text);
    const mustered: AssistantPart[] = m
      ? [{ type: 'notice', tone: 'info', ts, text: `Mustered into the feature branch: ${m[1]}${m[2] ? ` · not yet: ${m[2]}` : ''}` }]
      : [];
    return [{ type: 'agents', agents, ts }, ...mustered];
  }
  const note = data.text.replace(NOTIFICATION_OPEN, '').trim().split('\n')[0] ?? '';
  return [{ type: 'notice', tone: 'info', text: note, ts }];
}

/** Kelpie's own turns. Logs from before echoes carried `source` only have the tag to go by. */
export const fromKelpie = (data: EventOf<'message'>['data']) =>
  data.source === 'kelpie' || (data.source === undefined && data.sent === true && data.text.startsWith(NOTIFICATION_OPEN));

/**
 * Folds a session's KEF events into chat items: user turns, and one
 * assistant item per stretch of agent activity between them. Pure, so the
 * UI can recompute it from the event log on every update.
 */
export function buildChat(events: readonly KelpieEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, ToolView>();
  const spawns = new Map<string, SpawnView>();
  const plans = new Map<string, PlanView>();
  /** By call id, and by request id once asked. */
  const questions = new Map<string, QuestionView>();

  const assistant = (id: string): AssistantPart[] => {
    const last = items.at(-1);
    if (last?.role === 'assistant') return last.parts;
    const parts: AssistantPart[] = [];
    items.push({ role: 'assistant', id, parts });
    return parts;
  };

  for (const ev of events) {
    if (ev.parentCallId) {
      subAgentStep(tools.get(ev.parentCallId), ev);
      continue;
    }
    switch (ev.kind) {
      case 'message':
        // Turns Kelpie sent itself (notifications, restarts) are not the person speaking.
        if (ev.data.role === 'user' && fromKelpie(ev.data)) assistant(ev.id).push(...kelpieTurn(ev.data, ev.ts));
        else if (ev.data.role === 'user')
          items.push({
            role: 'user',
            id: ev.id,
            text: ev.data.attachments?.length ? stripAttachments(ev.data.text) : ev.data.text,
            ts: ev.ts,
            ...(ev.data.source ? { source: ev.data.source } : {}),
            ...(ev.data.attachments?.length ? { attachments: ev.data.attachments } : {}),
          });
        else assistant(ev.id).push({ type: 'text', text: ev.data.text, ts: ev.ts });
        break;
      case 'thinking':
        // Claude Code withholds thinking text; an empty block has nothing to show.
        if (!ev.data.redacted) assistant(ev.id).push({ type: 'reasoning', text: ev.data.text, ts: ev.ts });
        break;
      case 'tool.started': {
        // Todo lists live in the agent pane, by agent, not scattered through the chat; a plan put to
        // the person shows as its card.
        if (ev.data.category === 'todo' || ev.data.name === 'ExitPlanMode') break;
        // Questions show as their card, from the call on (it is put to the person a moment later).
        if (ev.data.name === ASK_TOOL) {
          const qs = questionsOf(ev.data.input);
          if (qs) {
            const view: QuestionView = { type: 'question', callId: ev.data.callId, questions: qs, state: 'asking', ts: ev.ts };
            questions.set(`call:${view.callId}`, view);
            assistant(ev.id).push(view);
            break;
          }
        }
        if (ev.data.name === SPAWN_TOOL) {
          const input = (ev.data.input ?? {}) as { title?: unknown };
          const view: SpawnView = { type: 'spawn', callId: ev.data.callId, title: typeof input.title === 'string' ? input.title : 'Agent', state: 'running' };
          spawns.set(view.callId, view);
          assistant(ev.id).push(view);
          break;
        }
        const view: ToolView = { type: 'tool', ...ev.data, state: 'running', steps: [], ts: ev.ts };
        tools.set(view.callId, view);
        assistant(ev.id).push(view);
        break;
      }
      case 'tool.finished': {
        const spawn = spawns.get(ev.data.callId);
        if (spawn) settleSpawn(spawn, ev.data.ok, ev.data.output);
        // Never put to the person (an older log, or the harness settled it): it ended as the tool did.
        const asked = questions.get(`call:${ev.data.callId}`);
        if (asked?.state === 'asking') asked.state = ev.data.ok ? 'answered' : 'refused';
        const view = tools.get(ev.data.callId);
        if (!view) break;
        view.state = ev.data.ok ? 'done' : 'error';
        view.output = ev.data.truncated ? `${ev.data.output}\n…` : ev.data.output;
        break;
      }
      case 'file.changed': {
        const view = tools.get(ev.data.callId);
        if (view) view.delta = { added: ev.data.added, removed: ev.data.removed };
        break;
      }
      // Plans and questions are answered in the chat; other permission requests in the approvals tray.
      case 'permission.requested':
        if (ev.data.questions?.length) {
          const known = ev.data.callId ? questions.get(`call:${ev.data.callId}`) : undefined;
          const view: QuestionView = known ?? { type: 'question', questions: ev.data.questions, state: 'open', ts: ev.ts };
          Object.assign(view, { requestId: ev.data.requestId, questions: ev.data.questions, state: 'open' });
          questions.set(`req:${view.requestId}`, view);
          if (!known) assistant(ev.id).push(view);
        } else if (ev.data.tool === 'ExitPlanMode') {
          const view: PlanView = { type: 'plan', requestId: ev.data.requestId, plan: ev.data.plan ?? '', state: 'open', ts: ev.ts };
          plans.set(view.requestId, view);
          assistant(ev.id).push(view);
        }
        break;
      case 'permission.resolved': {
        const question = questions.get(`req:${ev.data.requestId}`);
        if (question) {
          question.state = ev.data.decision === 'allow' ? 'answered' : ev.data.by === 'person' ? 'skipped' : ev.data.by === 'kelpie' ? 'refused' : 'expired';
          if (ev.data.answers) question.answers = ev.data.answers;
          break;
        }
        const view = plans.get(ev.data.requestId);
        if (!view) break;
        view.state = ev.data.decision === 'allow' ? 'approved' : ev.data.by === 'person' ? 'declined' : 'expired';
        if (ev.data.by === 'person' && ev.data.message) view.message = ev.data.message;
        break;
      }
      case 'turn.ended':
        if (ev.data.status === 'failed') assistant(ev.id).push({ type: 'notice', tone: 'error', text: ev.data.error ?? 'The turn failed.', ts: ev.ts });
        if (ev.data.status === 'interrupted') assistant(ev.id).push({ type: 'notice', tone: 'info', text: 'Interrupted.', ts: ev.ts });
        break;
      case 'process.exited':
        // Tools still open when the process is gone will never finish, even if a later run resumes the session.
        tools.forEach((t) => t.state === 'running' && (t.state = 'error'));
        spawns.forEach((s) => s.state === 'running' && (s.state = 'error'));
        questions.forEach((q) => (q.state === 'asking' || q.state === 'open') && (q.state = 'expired'));
        if (ev.data.code) {
          const detail = ev.data.stderrTail.trim().split('\n').slice(-3).join('\n');
          assistant(ev.id).push({ type: 'notice', tone: 'error', text: `Agent process exited with code ${ev.data.code}${detail ? `: ${detail}` : ''}`, ts: ev.ts });
        }
        break;
    }
  }
  return items;
}

function subAgentStep(parent: ToolView | undefined, ev: KelpieEvent): void {
  if (!parent || ev.kind !== 'tool.started') return;
  const { category, title } = (ev as EventOf<'tool.started'>).data;
  parent.steps.push(`${category} ${title}`);
}

/** spawn_agent answers with `{ agentId }` as JSON, or with the reason it refused. */
function settleSpawn(view: SpawnView, ok: boolean, output: string): void {
  try {
    const parsed = JSON.parse(output) as { agentId?: unknown };
    if (ok && typeof parsed.agentId === 'string') {
      view.state = 'done';
      view.agentId = parsed.agentId;
      return;
    }
  } catch {}
  view.state = 'error';
  view.error = output.trim();
}

/** The round-up's own todo list as it last wrote it (not one its sub-agents kept), for the todo dock. */
export function latestTodos(events: readonly KelpieEvent[]): TodoItem[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'todos' && !e.parentCallId) return e.data.items;
  }
  return [];
}
