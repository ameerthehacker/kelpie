import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Context } from 'hono';
import { z } from 'zod';
import { Harness } from '@kelpie/protocol';
import { isLocalHost } from '../local.js';
import type { Session } from '../sessions.js';
import { ToolError, type Orchestrator } from './orchestrator.js';

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

/** The kelpie tools, bound to the orchestrator round-up that is calling. */
function server(orch: Orchestrator, parent: Session): McpServer {
  const mcp = new McpServer({ name: 'kelpie', version: '0.0.0' });

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
        files,
      },
    },
    (input) => result(() => orch.spawn(parent, input)),
  );

  mcp.registerTool(
    'list_agents',
    {
      description:
        'The base branch, your feature branch and where it is checked out (featureCheckout, which you may read), and your sub-agents with their status (working, idle, or waiting to resume), last turn result, cost, ' +
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

  return mcp;
}

/**
 * The kelpie MCP server over Streamable HTTP, stateless: each request gets a fresh server
 * bound to the orchestrator its bearer token belongs to. Loopback only, like the API.
 */
export async function handleMcp(c: Context, orch: Orchestrator): Promise<Response> {
  if (!isLocalHost(c.req.header('host'))) return c.text('forbidden host', 403);
  // Harnesses send no Origin; a browser page always does.
  if (c.req.header('origin')) return c.text('forbidden origin', 403);
  const token = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];
  const parent = orch.authorize(token);
  if (!parent) return c.json({ error: 'unknown or expired token' }, 401);
  // Stateless mode has no server-to-client stream to offer.
  if (c.req.method !== 'POST') return c.json({ error: 'method not allowed' }, 405);

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const mcp = server(orch, parent);
  await mcp.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    void mcp.close();
  }
}
