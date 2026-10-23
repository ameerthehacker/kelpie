# Kelpie

An orchestrator for existing coding-agent harnesses (Claude Code, Codex). Kelpie never runs its own agent loop: it drives the harness CLIs, so users keep their own subscriptions. The orchestrator is itself a harness session, given Kelpie tools to spawn and track sub-agents.

Every harness stream is normalized into the **Kelpie Event Format (KEF)**. The UI renders KEF and the orchestrator reasons over it, so neither knows which CLI produced an event.

## Phases

| # | Scope | State |
|---|---|---|
| 1 | Protocol (KEF) + Claude Code adapter + dev runner | done |
| 2 | Codex adapter | |
| 3 | SQLite store, agent digests (orchestrator memory) | |
| 4 | Supervisor: scheduling, dependencies, worktrees, questions | |
| 5 | Kelpie MCP server (orchestrator + sub-agent tools) | |
| 6 | Orchestrator runner | |
| 7 | HTTP / WebSocket API | |
| 8 | Web UI (design canvas "Kelpie") | |

## Layout

```
packages/protocol   KEF types + zod schemas
packages/adapters   harness adapters: spawn, parse, fixtures, golden tests
scripts/            capture-claude.ts (fixtures), run.ts (dev runner)
```

Workspace packages export their TypeScript source under the `kelpie-src` condition (used by tsx and vitest) and `dist/` otherwise.

## KEF

Envelope: `{ id, runId, seq, ts, harness, kind, data, parentCallId?, rawLine? }`. `seq` is contiguous per run. `parentCallId` marks events from inside a sub-agent; it is the id of the tool call that spawned the sub-agent. `rawLine` points into the run's `raw.jsonl`.

| kind | meaning |
|---|---|
| `session.started` | harness session id, model, cwd, tools |
| `message` | assistant text, or a user turn (turns Kelpie sent are recorded by the adapter) |
| `thinking` | reasoning; `redacted` when the CLI only sends a signature |
| `tool.started` / `tool.finished` | a tool call with a category (`read search edit bash web todo task mcp other`) and a one-line title |
| `file.changed` | a successful edit or write with +/- line counts |
| `todos` | full todo-list snapshot after each change |
| `usage` | tokens and cost **for that turn** |
| `rate_limit` | subscription window status and utilization |
| `turn.ended` | `completed` / `failed` / `interrupted` |
| `process.exited` | exit code and stderr tail |
| `other` | anything not understood yet; kept, never dropped |

## Claude Code adapter

Kelpie runs a long-lived `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --strict-mcp-config --tools <set>`. Each user turn is one JSON line on stdin. All of the following was checked against CLI 2.1.308 (fixtures in `packages/adapters/fixtures/claude-code`):

- **Turns.** `system/init` is re-sent at the start of every turn with the same `session_id`; the parser emits `session.started` only for a new session.
- **Turns are not 1:1 with sends.** Messages sent mid-turn are queued, and the CLI may merge several into one turn and one `result` (fixture `queued`). It also starts turns by itself: when a background sub-agent finishes, a new turn and `result` follow with no message from us (fixture `background-agent`). So `busy` is tracked from the stream, not by counting: `--replay-user-messages` echoes each stdin turn (`isReplay: true`) as the CLI takes it in, any assistant or user activity marks a turn in progress, and `result` ends it. The echoes are also how sent turns become `message` events. Other user text on stdout is a sub-agent's prompt.
- **Usage and cost.** `result.usage` covers one turn, but `total_cost_usd` is cumulative per process. The parser converts it to a per-turn cost.
- **Todos.** The todo tools are `TaskCreate` / `TaskUpdate` (`TodoWrite` is gone). They are not in the default tool set, and `--tools default,X` does not combine, so the adapter passes an explicit list. A new task's id appears only in the result (`tool_use_result.task.id`). There is one list per session, and sub-agents do not get these tools.
- **Sub-agents.** The sub-agent tool is `Agent`, and its events carry `parent_tool_use_id`. `system/task_*` and `background_tasks_changed` events track its progress (currently `other`). With `run_in_background`, the `Agent` call returns at once and the sub-agent keeps running after the turn's `result`. A `turn.ended` therefore does not mean the agent is finished; Phase 4 must account for this.
- **Edits.** `tool_use_result.structuredPatch` gives exact +/- counts for Edit and Write.
- **Interrupt.** Send stdin `{"type":"control_request","request_id":…,"request":{"subtype":"interrupt"}}`. The CLI answers with a `control_response`, writes a `[Request interrupted by user…]` marker, then emits `result` with `subtype: error_during_execution, terminal_reason: aborted_streaming`. The aborted `result` reports `total_cost_usd: 0`, so the cost baseline only ever moves forward. The session stays usable for further turns. Only if the CLI does not answer within 5s while still mid-turn does the adapter SIGINT it, which ends the process.
- **Resume.** `--resume <session_id>` in a new process keeps the same session id and context.
- **Noise.** `system/thinking_tokens` and `system/commands_changed` are dropped (they remain in `raw.jsonl`).
- **Rate limits.** `rate_limit_event` reports per-window utilization, which later phases will use to pace agents.

Every run writes `~/.kelpie/runs/<runId>/run.json` (argv, cwd) and `raw.jsonl` (the untouched stream). A run directory holds exactly one run, since `rawLine` indexes `raw.jsonl` from line 1. To continue a session, start a new run with `resume`.

## Developing

```sh
pnpm install
pnpm test                       # golden tests over the fixtures + spawn tests against a fake CLI
pnpm typecheck && pnpm build
pnpm capture:claude [scenario]  # re-record fixtures from the real CLI (uses haiku)
pnpm kelpie:run --cwd <repo> [--model m] [--resume id] [--json] [--verbose] "prompt"
```

In the dev runner: type a line to send another turn, Ctrl-C to interrupt the turn, and Ctrl-C again (or `/exit`) to end the session.
