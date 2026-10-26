import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Context } from 'hono';
import { z } from 'zod';
import { Harness } from '@kelpie/protocol';
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

/** A sub-agent's kelpie tools: only its review threads. */
function agentServer(orch: Orchestrator, agent: Session): McpServer {
  const mcp = new McpServer({ name: 'kelpie', version: '0.0.0' });
  reviewTools(mcp, orch, agent, 'assigned to you');
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
        `At most ${orch.maxAgents} agents work at once. Each writing agent gets its own git worktree and branch, cut from your feature branch; ` +
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
        model: z.string().optional().describe('Model override; omit to use the default.'),
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
        'The base branch, your feature branch and where it is checked out (featureCheckout, which you may read; brought back if it was cleaned up), and your sub-agents with their status (working, idle, or waiting to resume), last turn result, cost, ' +
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
        'Fixed once a writing agent has started.',
      inputSchema: { branch: z.string().min(1).describe('A branch from list_branches, e.g. origin/main.') },
    },
    ({ branch }) => result(() => orch.setBase(parent, branch)),
  );

  mcp.registerTool(
    'link_ticket',
    {
      description:
        'Link a Jira issue or Asana task or project to this round-up; the person sees it under the title. Links in their messages are linked already. ' +
        'Linking a ticket again (by any link to it) only sets its title. Returns the round-up\'s tickets.',
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

  return mcp;
}

/**
 * The kelpie MCP server over Streamable HTTP, stateless: each request gets a fresh server bound
 * to the session its bearer token belongs to (an orchestrator's tools, or an agent's review
 * tools). Loopback only, like the API.
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
