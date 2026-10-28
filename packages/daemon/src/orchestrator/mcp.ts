import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Context } from 'hono';
import { z } from 'zod';
import { CardCreate, CardUpdate, Effort, EntryPatch, Harness } from '@kelpie/protocol';
import { isLocalHost } from '../local.js';
import type { Session } from '../sessions.js';
import { ToolError } from '../errors.js';
import type { Orchestrator } from './orchestrator.js';

const agentId = z.string().describe('The id spawn_agent returned.');
const files = z
  .array(z.string())
  .optional()
  .describe('Paths of files in your scratch folder (uploads, or files you wrote there) for the agent; they are listed in its message for it to read.');

/** Tool results are JSON; refusals come back as errors the orchestrator can read and act on. */
async function result(fn: () => unknown): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await fn(), null, 2) }] };
  } catch (err) {
    if (err instanceof ToolError) return { content: [{ type: 'text', text: err.message }], isError: true };
    throw err;
  }
}

/** A tool that answers in plain text (the Workbench's compact views). */
async function text(fn: () => string | Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: await fn() }] };
  } catch (err) {
    if (err instanceof ToolError) return { content: [{ type: 'text', text: err.message }], isError: true };
    throw err;
  }
}

const threadId = z.string().describe('A thread id, from list_review_threads or the review notification.');
const replyBody = z.string().min(1).max(10_000);

/** The review tools every session has: on the threads assigned to it, or for the orchestrator every published one. */
function reviewTools(mcp: McpServer, orch: Orchestrator, session: Session, scope: string): void {
  mcp.registerTool(
    'list_review_threads',
    {
      description:
        `The person's review threads ${scope}: each with the line it is on (currentLine: where that line is now; outdated: it has changed since), ` +
        'the code excerpt (diffHunk) and the comments so far.',
      inputSchema: { status: z.enum(['open', 'resolved', 'all']).optional().describe('Default "open".') },
    },
    ({ status }) => result(() => orch.reviews.list(session, status)),
  );
  mcp.registerTool(
    'reply_to_thread',
    {
      description: 'Reply on a review thread: what you did about it, or why not, or an answer. The person sees it at once.',
      inputSchema: { threadId, body: replyBody.describe('Your reply, in markdown.') },
    },
    ({ threadId, body }) => result(() => orch.reviews.reply(session, threadId, body)),
  );
  mcp.registerTool(
    'resolve_thread',
    {
      description: 'Mark a review thread resolved once it is addressed, with an optional last reply.',
      inputSchema: { threadId, body: replyBody.optional().describe('A reply to add first, e.g. what you changed.') },
    },
    ({ threadId, body }) => result(() => orch.reviews.resolve(session, threadId, body)),
  );
}

/**
 * The Workbench tools every session has, always as itself: read its round-up's board and post notes.
 * Agents also set their own entry; the orchestrator keeps the cards.
 */
function workbenchTools(mcp: McpServer, orch: Orchestrator, session: Session): void {
  const agent = session.role === 'agent';
  mcp.registerTool(
    'workbench_read',
    {
      description:
        "The Workbench: this round-up's feature cards and its agents, each with status, focus, claimed files or areas, blocker and progress; " +
        'agents in other round-ups claiming files in the same repo; ' +
        (agent ? 'where your claims overlap others\'; ' : '') +
        'notes for you (handed over now) and recent notes. Read it before touching files other agents may be changing.',
    },
    () => text(() => orch.workbench.read(session)),
  );
  if (agent) {
    mcp.registerTool(
      'workbench_update',
      {
        description:
          'Set your own entry on the Workbench, which the person and the other agents see: what you are doing, the files or areas you are changing, ' +
          'what blocks you, how far you have got. Only the fields given change; null clears one. Call it when you start and at meaningful points, not after every step. ' +
          'Says whose claims overlap yours.',
        inputSchema: EntryPatch.shape,
      },
      (patch) => text(() => orch.workbench.setEntry(session, patch)),
    );
  }
  mcp.registerTool(
    'workbench_post',
    {
      description:
        'Post a short note to the Workbench, optionally to one agent (by its title) or to "orchestrator". A note to someone is handed to it with its next turn ' +
        'or when it reads the board; it never interrupts or wakes anyone. Use it to ask for or offer something another agent needs (an interface, a file to leave alone). ' +
        'Limited to a few notes per recipient every few minutes; never post just to acknowledge.',
      inputSchema: {
        note: z.string().min(1).max(2000).describe('Self-contained: what you need or are telling them, and why.'),
        to: z.string().optional().describe('An agent\'s title in this round-up (or its id), or "orchestrator". Omit for everyone.'),
        ...(agent ? {} : { card: z.string().optional().describe('The card it is about (its id). Default: your latest open card.') }),
      },
    },
    (input) =>
      result(() => {
        const { note, delivery } = orch.workbench.post(session, session.roundUpId, input);
        return { posted: note.id, ...(note.toTitle ? { to: note.toTitle } : {}), delivery };
      }),
  );
}

/** A sub-agent's kelpie tools, all as itself: its review threads and the Workbench. */
function agentServer(orch: Orchestrator, agent: Session): McpServer {
  const mcp = new McpServer({ name: 'kelpie', version: '0.0.0' });
  reviewTools(mcp, orch, agent, 'assigned to you');
  workbenchTools(mcp, orch, agent);
  return mcp;
}

/** The kelpie tools, bound to the orchestrator round-up that is calling. */
function orchestratorServer(orch: Orchestrator, parent: Session): McpServer {
  const mcp = new McpServer({ name: 'kelpie', version: '0.0.0' });
  reviewTools(mcp, orch, parent, 'in this round-up (submitted ones)');

  mcp.registerTool(
    'read_review',
    {
      description: "A review the person submitted (default: the latest), with its threads and every thread still open, each with whose code it is on and who it is assigned to.",
      inputSchema: { reviewId: z.string().optional().describe('From the review notification; omit for the latest.') },
    },
    ({ reviewId }) => result(() => orch.reviews.read(parent.id, reviewId)),
  );

  mcp.registerTool(
    'assign_threads',
    {
      description:
        'Hand open review threads to a writer to fix, reply on and resolve. With agentId: that writing agent of yours, picked up again with a brief of the threads ' +
        '(a mustered one gets a fresh worktree from your feature branch). Without: Kelpie starts a new writer ("Review fixes", deliver "muster") with them. ' +
        'You are notified when it goes idle, as for any agent.',
      inputSchema: {
        threadIds: z.array(z.string()).min(1).describe('Open threads of this round-up.'),
        agentId: z.string().optional().describe('A writing agent to give them to; omit to start a new one.'),
        title: z.string().optional().describe('The new agent\'s title, when there is no agentId. Default "Review fixes".'),
        notes: z.string().optional().describe('Anything the agent should know beyond the threads themselves.'),
      },
    },
    (input) => result(() => orch.assignThreads(parent, input)),
  );

  mcp.registerTool(
    'spawn_agent',
    {
      description:
        'Start a sub-agent on one self-contained unit of work. Returns at once; Kelpie notifies you when it goes idle. ' +
        `At most ${orch.maxAgents} agents work at once (the person's limit, which they may change; list_agents has the current one). Each writing agent gets its own git worktree and branch, cut from your feature branch; ` +
        'the first writer needs a base branch (see set_base_branch).',
      inputSchema: {
        title: z.string().min(1).describe('Short name for this unit of work, shown to the person.'),
        task: z
          .string()
          .min(1)
          .describe('The complete brief. The agent sees nothing else: include the goal, all needed context, what done looks like, and what to report.'),
        writes: z.boolean().describe('True only if the unit must change files.'),
        deliver: z
          .enum(['muster', 'standalone'])
          .optional()
          .describe('Writers only. "muster" (default): its branch is brought into your feature branch with muster_agents. "standalone": a self-contained piece that ships on its own branch.'),
        in: z.string().optional().describe("Read-only agents only: an agent id whose worktree to look at (e.g. to review its work). Default: your feature branch."),
        harness: Harness.optional().describe('Which coding agent runs it. Default claude-code.'),
        model: z.string().optional().describe("Model override; omit for the round-up's (the person's choice)."),
        effort: Effort.optional().describe(
          "How hard it thinks, lowest first: low, medium, high, xhigh, max. Omit for the round-up's (the person's choice; list_agents has it). " +
            'Use low for quick mechanical work (renames, lookups, running a command) and high for hard, subtle work; xhigh and max only when a unit clearly needs them. ' +
            "If the round-up has an effort, never go above it unless the person asks for more.",
        ),
        browser: z
          .boolean()
          .optional()
          .describe(
            "Give this agent the Claude in Chrome tools to drive the person's logged-in Chrome. Use only when a page needs a real browser " +
              '(it renders only there, or needs their login); WebFetch does for public pages. Only one such agent works at a time, and none in plan mode.',
          ),
        files,
      },
    },
    (input) => result(() => orch.spawn(parent, input)),
  );

  mcp.registerTool(
    'list_agents',
    {
      description:
        'The base branch, your feature branch and where it is checked out (featureCheckout, which you may read; brought back if it was cleaned up), ' +
        'how many agents may work at once (maxAgents, set by the person) and how many are working, and your sub-agents with their status (working, idle, or waiting to resume), last turn result, cost, ' +
        'and for writers their branch and whether it is still to muster, mustered, or standalone.',
    },
    () => result(() => orch.list(parent)),
  );

  mcp.registerTool(
    'read_agent',
    {
      description:
        'Read a sub-agent. detail "report" (default): its final report, files changed, todos, last error. ' +
        'detail "log": compact numbered log lines after cursor `after`; pass nextCursor back to read on.',
      inputSchema: {
        agentId,
        detail: z.enum(['report', 'log']).optional(),
        after: z.number().int().optional().describe('Log cursor; omit to start at the beginning.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max log lines (default 60).'),
      },
    },
    ({ agentId, detail, after, limit }) => result(() => orch.read(parent, agentId, detail, after, limit)),
  );

  mcp.registerTool(
    'message_agent',
    {
      description: 'Send a sub-agent a follow-up or an answer to its questions. It resumes its session with all its context.',
      inputSchema: { agentId, text: z.string().min(1).describe('Self-contained: say what you need and why.'), files },
    },
    ({ agentId, text, files }) => result(() => orch.message(parent, agentId, text, files)),
  );

  mcp.registerTool(
    'interrupt_agent',
    { description: 'Stop the sub-agent turn in progress. The agent keeps its context for later messages.', inputSchema: { agentId } },
    ({ agentId }) => result(() => orch.interrupt(parent, agentId)),
  );

  mcp.registerTool(
    'muster_agents',
    {
      description:
        "Bring finished writers' branches into your feature branch, in the order given. Kelpie merges each one git can merge cleanly; " +
        'at the first conflict it starts a Muster agent with the rest (you are notified when it is done). Only for writers with deliver "muster".',
      inputSchema: {
        agentIds: z.array(z.string()).min(1).describe('The writers to muster, in merge order.'),
        notes: z.string().optional().describe('Anything Muster should know, e.g. which change wins where two overlap.'),
      },
    },
    ({ agentIds, notes }) => result(() => orch.muster(parent, agentIds, notes)),
  );

  mcp.registerTool(
    'list_branches',
    { description: "The repo's branches a round-up can start from (remote first), and the base branch already chosen, if any." },
    () => result(() => orch.branches(parent)),
  );

  mcp.registerTool(
    'set_base_branch',
    {
      description:
        'Set the branch this round-up starts from, as the person chose it (never pick it yourself). A remote branch is fetched first. ' +
        'Fixed once a writing agent has started or the feature checkout is open.',
      inputSchema: { branch: z.string().min(1).describe('A branch from list_branches, e.g. origin/main.') },
    },
    ({ branch }) => result(() => orch.setBase(parent, branch)),
  );

  mcp.registerTool(
    'open_feature_checkout',
    {
      description:
        'Make your feature branch\'s checkout if it does not exist yet (from the base branch; see set_base_branch), or bring it back if it was cleaned up, and return its path. ' +
        'Edit there by absolute path; your commands run there (Kelpie starts each one there unless your shell is already inside it). Kelpie commits what you leave uncommitted when your turn ends, and before it starts a writer or musters. ' +
        'Writers fork from the feature branch, so their work starts from yours.',
    },
    () => result(() => orch.openFeatureCheckout(parent)),
  );

  mcp.registerTool(
    'link_ticket',
    {
      description:
        'Link a Jira issue or Asana task or project to this round-up; the person sees it under the title. Links in their messages are linked already. ' +
        'Linking a ticket again (by any link to it) only sets its title (never over one the person gave). Returns the round-up\'s tickets.',
      inputSchema: {
        url: z.string().min(1).describe('The ticket\'s link: https://<org>.atlassian.net/browse/KEY-123 (or a board link to it), or an app.asana.com task or project link.'),
        title: z.string().max(200).optional().describe('A readable name, when you know it: the Jira summary, the Asana task\'s or project\'s name.'),
      },
    },
    ({ url, title }) => result(() => orch.linkTicket(parent, url, title)),
  );

  mcp.registerTool(
    'unlink_ticket',
    { description: 'Unlink a ticket from this round-up, e.g. one linked by mistake.', inputSchema: { url: z.string().min(1).describe('Any link to the ticket.') } },
    ({ url }) => result(() => orch.unlinkTicket(parent, url)),
  );

  mcp.registerTool(
    'create_card',
    {
      description:
        "Put a feature you take on on the person's Workbench: one card per feature (a round-up can have several). It shows the stage, a callout when you need the person, " +
        "the tickets (default: the round-up's) and an item per deliverable: key it by the agent's id for its writer item. Returns the card's id and link.",
      inputSchema: CardCreate.shape,
    },
    (input) => result(() => orch.workbench.create(parent, input)),
  );

  mcp.registerTool(
    'update_card',
    {
      description:
        'Keep a Workbench card current: its stage (blocked, building, review, ready, done), callout (null clears it), tickets, and items (upserted by key; remove: true drops one). ' +
        "Only the fields given change. Kelpie fills in each item's agent status, approvals and merged by itself.",
      inputSchema: CardUpdate.shape,
    },
    (input) => result(() => orch.workbench.update(parent, input)),
  );

  workbenchTools(mcp, orch, parent);

  return mcp;
}

/**
 * The kelpie MCP server over Streamable HTTP, stateless: each request gets a fresh server bound
 * to the session its bearer token belongs to (an orchestrator's tools, or an agent's review and
 * Workbench tools). Loopback only, like the API.
 */
export async function handleMcp(c: Context, orch: Orchestrator): Promise<Response> {
  if (!isLocalHost(c.req.header('host'))) return c.text('forbidden host', 403);
  // Harnesses send no Origin; a browser page always does.
  if (c.req.header('origin')) return c.text('forbidden origin', 403);
  const token = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];
  const session = orch.authorize(token);
  if (!session) return c.json({ error: 'unknown or expired token' }, 401);
  // Stateless mode has no server-to-client stream to offer.
  if (c.req.method !== 'POST') return c.json({ error: 'method not allowed' }, 405);

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const mcp = session.role === 'orchestrator' ? orchestratorServer(orch, session) : agentServer(orch, session);
  await mcp.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    void mcp.close();
  }
}
