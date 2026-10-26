# Kelpie

An orchestrator for existing coding-agent harnesses (Claude Code, Codex). Kelpie never runs its own agent loop: it drives the harness CLIs, so users keep their own subscriptions. The orchestrator is itself a harness session, given Kelpie tools to spawn and track sub-agents.

Every harness stream is normalized into the **Kelpie Event Format (KEF)**. The UI renders KEF and the orchestrator reasons over it, so neither knows which CLI produced an event.

## Phases

| # | Scope | State |
|---|---|---|
| 1 | Protocol (KEF) + Claude Code adapter + dev runner | done |
| 2 | Codex adapter | |
| 3 | SQLite store, agent digests (orchestrator memory) | partial: round-ups + KEF logs (`packages/store`, Drizzle) |
| 4 | Supervisor: scheduling, dependencies, worktrees, questions | partial: concurrency cap, a worktree per writer with Muster, crash recovery |
| 5 | Kelpie MCP server (orchestrator + sub-agent tools) | partial: orchestrator tools (`packages/daemon/src/orchestrator`) |
| 6 | Orchestrator runner | basic: every top-level round-up is an orchestrator |
| 7 | HTTP API | basic: persistent round-ups + SSE (`packages/daemon`) |
| 8 | Web UI (design canvas "Kelpie") | the workspace design: sidebar, chat, agent pane, themes, settings (`apps/web`) |

## Layout

```
packages/protocol   KEF types + zod schemas
packages/adapters   harness adapters: spawn, parse, fixtures, golden tests
packages/store      SQLite via Drizzle ORM (better-sqlite3): round-ups and their KEF logs
packages/daemon     HTTP API: round-ups over the adapter, KEF over SSE; the orchestrator and its MCP server
apps/web            chat UI: Vite + React + shadcn/ui + AI Elements
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
| `activity` | busy flipped: a turn started, or the agent went idle. In-stream, so consumers never see busy run ahead of the events |
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

Every run writes `run.json` (argv, cwd) and `raw.jsonl` (the untouched stream) to its run directory: `$KELPIE_HOME/runs/<runId>` (see below for the default), or `~/.kelpie/runs/<runId>` when a caller of the adapter gives none. A run directory holds exactly one run, since `rawLine` indexes `raw.jsonl` from line 1. To continue a session, start a new run with `resume`.

## Daemon and web UI

`pnpm kelpie:serve --cwd <repo>` starts the daemon on `127.0.0.1:7317`. It also serves `apps/web/dist` when that has been built.

- **Round-ups.** A round-up (API: session) is one conversation: a KEF log that spans harness processes, stored in `$KELPIE_HOME/kelpie.db` (default `~/.kelpie` for the installed `kelpie`, `~/.kelpie-dev` for the dev daemon). Each event is written before subscribers see it, and its log index is its SSE id. Run logs go to `$KELPIE_HOME/runs/<runId>/raw.jsonl`.
- **Resume.** The harness session id is stored, so when the process has exited (idle for 10 minutes, daemon restarted) the next message starts a new one with `--resume`. If resuming fails (the transcript is gone), the id is dropped and the next message starts fresh.
- **One daemon per data directory.** It holds `$KELPIE_HOME/daemon.lock` (proper-lockfile). A daemon that starts while its predecessor is still shutting down waits for the lock rather than repairing runs that are still being written. A lock left by a killed daemon goes stale after 5 seconds.
- **Restarts.** On shutdown the daemon stops every process and logs its closing events. If it was killed instead, startup closes out any run left open (`turn.ended` interrupted, `activity` idle, `process.exited`), so nothing stays "working".
- **Deletes** end the round-up's open event streams, so other tabs find out. A log stays in daemon memory only while a page watches it or a run writes to it.
- **Outbox.** Every turn sent to a round-up (the person's messages, a sub-agent's brief and follow-ups, Kelpie's notifications) is written to the `outbox` table before it goes to stdin. The harness echoes sent turns in order, and the parser marks those echoes `sent: true`. Each echo marks the oldest undelivered row delivered, in the same transaction that logs it, and the logged `message` gets that row's `source` (`user`, `orchestrator` or `kelpie`). That is how the UI tells notifications from the person's words. Turns still undelivered when Kelpie stops are re-sent by the next start, so a crash loses nothing and nothing is sent twice. Turns a harness process died before reading are dropped instead, so a turn that kills the CLI is never retried forever: the failed turn shows in the log and can be sent again. A resume failure is the exception: those turns are retried once, in a fresh session.
- **Usage limits.** Claude Code reports its subscription windows (`five_hour`, `seven_day`: utilization and reset time) in `rate_limit_event`s, which become KEF `rate_limit` events with `windows`. The daemon keeps each harness's latest report in `harness_usage`, because a harness only reports during a turn. The sidebar shows them as the design's Usage limit and Weekly limit meters, amber from 80%, and the composer warns when the fullest window passes 80%. A window whose reset time has passed shows 0% until the next turn reports again. Plan names aren't reported, so they aren't shown.
- **API.** `GET`/`POST /api/sessions`, `GET`/`PATCH {title}`/`DELETE /api/sessions/:id`, `POST /api/sessions/:id/messages {text}`, `POST /api/sessions/:id/interrupt`, `GET /api/health` (includes `defaultCwd`), `GET /api/usage`, `GET /api/harnesses/status`, `/api/connections` (below).
- **Event streams** (SSE, with a ping every 15s). `GET /api/sessions/:id/events` carries `kef` events; `Last-Event-ID` (or `?after=`) resumes exactly where a connection left off. `GET /api/events` carries the round-up list and usage: `sessions` (top-level round-ups), `sub-agents` and `usage` snapshots, then `session` (a round-up's or a sub-agent's) on create, rename, busy flip or turn end, `deleted`, and `usage` whenever a harness reports.
- **Harness setup** (`harness-status.ts`). `GET /api/harnesses/status` lists each harness CLI's `HarnessStatus` (`@kelpie/protocol`): `{ harness, installed, path?, onPath?, version?, loggedIn, authMethod?, error?, platform }`, checked afresh on every request (concurrent requests share one check; `cache-control: no-store`). `platform` is the daemon's `process.platform`, which picks the installer to show (a daemon in WSL is `linux`, whatever the browser is). For Claude Code: the binary is looked up on PATH (`which`), the version parsed from `claude --version`, and sign-in read from `claude auth status --json`, which answers from local credentials without spending tokens and covers claude.ai accounts, API keys and Bedrock/Vertex (signed out exits 1, still with the JSON; only `loggedIn` and `authMethod` are kept, never the email or organization). A CLI without that command, or garbled output, falls back to `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`, else `loggedIn: null` (can't tell). Not on PATH, it is looked for where the installers put it (`~/.local/bin` first); found there it is still asked, but reported `onPath: false`, since agents are started as `claude` on the daemon's PATH and only a restart from a terminal that has it on PATH fixes that. Each command is SIGKILLed after 10s, and the whole check answers within 25s with what it found by then, so a hung CLI can't hang the shared check.
- **Startup without Claude Code.** Resuming interrupted work starts harnesses, and one that can't start dies before reading its turns, which drops them. So `startDaemon` resumes only once a check finds `claude` on PATH: at startup, or the first `GET /api/harnesses/status` that does (Check again), or else the next start.
- **Connections** (`packages/daemon/src/connectors`). A connector (id, name, `check`, `connect`, `disconnect`, `env`) links Kelpie to a service; `Connections` holds them and each one's last status. Only GitHub exists so far.
  - **GitHub.** The person's `gh` login is used when there is one: its token is read with `gh auth token` each time it is needed, never copied. Otherwise they paste a personal access token, which is checked against `GET /user` (Octokit; login, avatar, and scopes from `x-oauth-scopes`, which fine-grained tokens don't send) before it is stored. A stored token wins over gh, since the person chose it; disconnecting forgets it, and gh takes over again. A login borrowed from gh can't be disconnected from Kelpie (`gh auth logout`).
  - **Storage.** One `connections` row per connector (method, secret, account, scopes). The secret is plain text in `kelpie.db`, the person's own file under `KELPIE_HOME`. It is never sent to the browser, logged, or put in an event or `run.json`.
  - **Agents.** Before each harness process starts, the orchestrator's `prepare` hook reads every connector's env, and `specFor` passes it (`RunSpec.env`) to the orchestrator and its agents alike: `GH_TOKEN`, `GITHUB_TOKEN`, and a git credential helper for `https://github.com` (through `GIT_CONFIG_*`) that answers with `$GH_TOKEN`, so `gh` and `git push` over HTTPS work. A token GitHub refused is not passed on.
  - **API.** `GET /api/connections` (each status, re-checked when it is over 5 minutes old), `POST /api/connections/:id {token}`, `POST /api/connections/:id/check`, `DELETE /api/connections/:id`. Each answers with a status (`connected`, `method`, `account`, `scopes`, `error`, `cli`), never the secret.
  - **UI.** `ConnectionsSection` (`components/settings/connections-section.tsx`) lists the connectors: status, the account and its scopes, gh's state, the token form with GitHub's verdict, Check again and Disconnect.
- **Local only.** Agents can run shell commands, so the API only answers loopback Host names (defeats DNS rebinding), rejects non-local Origins, and requires JSON for writes (forces a CORS preflight, which is never granted).

The web app follows the design canvas's workspace: the page is a canvas holding three rounded cards (sidebar, chat, agent pane). The palette is the canvas's light and dark tokens (`src/index.css`), and shadcn's own variables point at them, so dialogs and menus follow the theme. The theme is system, light or dark, picked in the sidebar and kept in `localStorage` (`src/lib/theme.ts`; `index.html` applies it before first paint). Type is Geist, Geist Mono and Bricolage Grotesque for display. The chat opens with the round-up's title, its repo and a summary of its agents. Tool calls read as the design's steps ("Kelpie · N steps"): each says in words what happened (`src/lib/steps.ts`), keeps its raw command behind "Show commands" (one switch for the whole app), and opens to its diff or output. Agent notifications are one-line events. The composer picks the round-up's model (`model` on `POST`/`PATCH /api/sessions`; a change ends an idle process so the next turn uses it). ⌘K searches round-ups, this round-up's agents and a few actions. **Settings** (`/settings`, from the sidebar's gear and ⌘K) stacks one section per file in `src/components/settings`. Harness shows each CLI's status with Check again and copyable next steps (the official installer, then `claude` to sign in). The status is never treated as fresh (`staleTime: 0`, refetched on window focus), so coming back from the terminal re-checks. "Ready" (`isReady` in `src/lib/harness-setup.ts`, shared by the card and the dialog) means installed on PATH, signed in, and checked without error. One found off PATH gets the lines that add its directory to PATH, and is told to restart Kelpie from a new terminal. First run: while Claude Code is missing, off PATH or signed out, a setup dialog walks through install → sign in → Check again, says when all is green (or what is still unclear), and lets the person continue; it is derived from the live status, not stored, and "Not now" lasts until a reload. Connections follows Harness (see Connections above). Markdown renders with AI Elements (`Conversation`, `MessageResponse`). React Router serves `/` (a new round-up, stored on its first message) and `/r/:roundUpId`, both under one layout route so the page stays mounted when a new round-up gets its URL. Streams use `@microsoft/fetch-event-source` (retries with `Last-Event-ID`, a 404 means the round-up is gone) plus a watchdog for sockets that go silent. Times use date-fns. The round-up list, rename and delete go through TanStack Query; the list stream writes into its cache. `src/lib/chat.ts` folds the event log into chat items and is tested against the adapter fixtures.

Schema changes: edit `packages/store/src/schema.ts`, then `pnpm --filter @kelpie/store db:generate` writes a migration into `packages/store/drizzle/`, which the daemon applies at startup.

## Developing

```sh
pnpm install
pnpm test                       # golden tests over the fixtures + spawn tests against a fake CLI
pnpm typecheck && pnpm build   # via turbo
pnpm dev                        # turbo: daemon (tsx watch, :7317) + UI (vite, :5173, proxies /api)
KELPIE_CWD=<repo> pnpm dev      # point agents at another repo (default: this one); also KELPIE_PORT, KELPIE_MODEL, KELPIE_HOME
pnpm capture:claude [scenario]  # re-record fixtures from the real CLI (uses haiku)
pnpm kelpie:run --cwd <repo> [--model m] [--resume id] [--json] [--verbose] "prompt"
pnpm kelpie:serve --cwd <repo> [--model m]   # daemon only; serves apps/web/dist after `pnpm build`
```

The dev daemon (`pnpm dev`, `pnpm kelpie:serve`) keeps its data in `~/.kelpie-dev` unless `KELPIE_HOME` says otherwise, so it runs beside an installed Kelpie, which uses `~/.kelpie` and port 3173. `pnpm kelpie:run` writes its run logs there too.

The dev daemon used `~/.kelpie` before, and nothing was moved: round-ups from then are still in `~/.kelpie`. Open them with `KELPIE_HOME=~/.kelpie pnpm dev` while no installed Kelpie is running on it. Moving them isn't enough: their worktrees are git worktrees registered at their old paths.

The daemon restarts whenever its own source or an adapter's source changes. Round-ups survive the restart, but a turn in progress is interrupted.

In the dev runner: type a line to send another turn, Ctrl-C to interrupt the turn, and Ctrl-C again (or `/exit`) to end the session.

## Distribution

The npm package **`kelpie-code`** (`apps/cli`) gives a `kelpie` command that starts everything on **one port**: 3173 by default (`--port` or `KELPIE_PORT`). The daemon serves the API, the kelpie MCP server and the built UI together. `pnpm dev` is unchanged (daemon on 7317, Vite on 5173), so an installed Kelpie and a development one can run side by side.

- **Startup.** `startDaemon()` (`packages/daemon/src/start.ts`) is shared by the CLI and the dev entry point (`main.ts`). It takes the data-directory lock, opens the store, listens, and then reconciles worktrees and resumes interrupted work. A taken port (`PortInUseError`) or a busy data directory (`HomeInUseError`) is reported without crashing. `close()` stops the harnesses (work in progress resumes on the next start), closes the store, and frees the lock and the port.
- **CLI** (`apps/cli/src/cli.ts`, commander). Its options are `--port`, `--cwd`, `--home`, `--model` and `--no-open`. Before starting it checks Node 22 or newer and that `--cwd` exists. It asks the daemon's harness check once it has started, and only warns when Claude Code is missing, off PATH or signed out: the UI walks the person through setup. It opens the browser with `open`.
- **Package.** tsdown bundles Kelpie's own packages (`@kelpie/*`, from source) into `dist/cli.js`. Third-party dependencies, including the native `better-sqlite3`, are ordinary `dependencies`. `scripts/copy-assets.mjs` adds the built UI (`dist/web`) and the migrations (`dist/drizzle`, passed to `openStore` as `migrationsFolder`). `pnpm build:cli` builds the web app first (turbo).
- **Releases.** `pnpm release [patch|minor|major|x.y.z] [--dry-run]` (`scripts/release.ts`) runs only on master, and only when it is clean and level with origin. It runs typecheck, tests, the build, and `npm publish --dry-run`. Then it bumps, commits and tags locally, and publishes. A failed publish undoes the commit and tag. Last, it pushes master and the tag together with `git push --atomic`. A plain `npm publish` is refused by `prepublishOnly` (it needs `KELPIE_RELEASE=1`, which only the script sets).

## Orchestrator

(A Kelpie-owned task graph, with queued units and dependencies started by the daemon, is next: see TODO.md.)

Every top-level round-up is an **orchestrator**: a Claude Code session that tracks tasks and delegates, and never changes the repo or runs commands itself. The sub-agents it starts are child round-ups (`parentId`, `role: 'agent'`, `writes`). They are ordinary sessions with their own logs, kept out of the sidebar list. `GET /api/sessions/:id/agents` lists them, and `/r/:agentId` opens one.

- **The tool set enforces the role.** The orchestrator runs with the kelpie MCP server (`--allowedTools mcp__kelpie`) and, of the built-in tools, Read, Grep and Glob for its repo checkout (its cwd), its feature branch's worktree and its scratch folder, plus Edit and Write for its scratch folder only (below): no Bash, Agent or todo list, and no way to change the repo. Bash is left out because Claude Code approves some commands itself (read-only ones, and filesystem ones like `rm` in accept-edits) before Kelpie is asked, so it can't be held to read-only git. Its agents are its plan. Each unit of work is one agent, titled as the person should see it, and `list_agents` is its tracker. Sub-agents keep their own todo lists (TaskCreate), which the agent pane shows. The appended prompt (`orchestrator/prompt.ts`) only says how to use those tools. Sub-agents get the default tools minus Edit/Write/NotebookEdit when `writes` is false (Bash stays for inspection), and never the kelpie server, so they can't spawn agents.
- **MCP server.** It lives inside the daemon at `/mcp` (Streamable HTTP, stateless, `@modelcontextprotocol/sdk`), so its tools call `SessionManager` directly. Each orchestrator *process* gets a fresh bearer token in its `--mcp-config`, revoked when the process exits. The token tells a call which orchestrator is calling; tools only reach that orchestrator's own children. Loopback Host only, no Origin.
- **Tools.** `spawn_agent {title, task, writes, deliver?, in?, harness?, model?}` returns at once. `list_agents` (with the base and feature branch, and `featureCheckout`, the feature branch's worktree path while it is on disk). `muster_agents {agentIds, notes?}`, `list_branches`, `set_base_branch {branch}` (see Worktrees). `read_agent {agentId, detail: report|log, after?, limit?}` returns either the agent's final report, files changed, todos, cost and last error, or compact numbered log lines with a cursor (`orchestrator/digest.ts`). `message_agent {agentId, text, files?}`. `interrupt_agent {agentId}`. `files` (on `spawn_agent` too) are paths in the scratch folder; anything outside it is refused.
- **Rules.** At most `KELPIE_MAX_AGENTS` (default 4) of an orchestrator's agents work at once, and only one `writes` agent may be working per directory. In a git repo every writer has its own worktree, so writers run side by side; outside one they share the round-up's directory, one at a time. Refusals come back as tool errors that tell the orchestrator to end its turn and wait.
- **Worktrees and Muster** (`worktrees.ts`). Nothing is cut from whatever the checkout is on.
  - **Base branch.** The person picks it, in the composer or when the orchestrator asks (`spawn_agent` refuses a writer until `set_base_branch`). A remote branch is fetched, and its commit pinned in `sessions.baseCommit`.
  - **Home.** The first writer creates the orchestrator's home worktree on its feature branch, `kelpie/<title>-<id6>`, from the pinned commit.
  - **Writers.** Each writer gets its own worktree on `<feature>--<agent>-<id6>`, cut from home's tip. Its prompt names its branch, the feature branch and the base. Read-only agents run in home, or in one agent's worktree (`in`).
  - **Paths.** Worktrees live under `KELPIE_HOME/worktrees`, one fixed path per session. Harness sessions resume by directory, so a swept worktree is recreated at the same path (the `prepare` hook, before each process starts).
  - **Committing.** When a writer goes idle, Kelpie commits anything it left uncommitted, then notifies with its branch, commits ahead and diffstat.
  - **Muster.** `muster_agents` merges branches into home in order. Kelpie runs `git merge --no-ff` itself, and at the first conflict hands the rest to a Muster agent (`kind: 'muster'`, writing in home) with each agent's task and report. Whether a branch is in follows git (it has commits since its `forkCommit`, and home contains them), not the report.
  - **After muster.** A mustered agent's worktree and branch go. `deliver: 'standalone'` branches are never mustered.
  - **Cleanup.**
    - Mustered worktrees go at once.
    - Clean worktrees idle for `KELPIE_WORKTREE_IDLE_DAYS` (3) are swept hourly; their branches stay.
    - At most `KELPIE_MAX_WORKTREES` (20) exist at once, and the oldest clean idle ones make room.
    - Deleting a round-up commits leftovers and removes its worktrees, and deletes only branches whose work is merged.
    - On start, `reconcile()` makes the disk match the `worktrees` table. That table is written before git runs.
    - Deleting one agent commits its leftovers and removes its worktree; its branch stays unless merged. A stray folder found on start is committed before removal.
  - **Git.** Git runs one command at a time per repo, never prompts (credentials off, ssh in batch mode), and every command has a time limit (60s, 120s for a fetch). A sweep re-checks "is anyone working here?" under the repo's lock before removing, and preparing a worktree waits for a removal already under way.
- **Uploads and the scratch folder.** Each round-up has a scratch folder, `KELPIE_HOME/scratch/<roundUpId>`, removed with the round-up.
  - **Uploads.** `POST /api/sessions/:id/uploads` takes the raw bytes (`application/octet-stream`, the CSRF guard's other allowed type) with the name in `x-file-name`, up to `KELPIE_MAX_UPLOAD_MB` (25). It saves them to `uploads/<id8>-<safe name>` and records an `attachments` row. A message's `attachments` lists upload ids. `GET /api/sessions/:id/uploads/:upload` serves one back: images and PDFs in place, anything else (SVG included) as a download, sandboxed.
  - **Sending.** A turn's files are listed by path in an `<attachments>` block at the end of its text, so the harness reads them with its own tools. A turn re-sent after a crash carries them too. The echo's `attachments` (id, name, mime, size) feed the UI's chips, and the chat strips the block.
  - **Who can touch it.** The orchestrator runs in `default` mode with `--add-dir <scratch>` and an allow rule `Read(//<scratch>/**)`. Reading its cwd and the scratch folder needs no permission (Claude Code settles those itself). Everything else asks, and `decide` answers: reads of the feature branch's worktree and edits in the scratch folder are allowed, anything else is refused. Deny rules for Edit and Write on its repo cwd and on Kelpie's worktree root back that up, in case the project's or the person's settings allow edits there (the cwd's only while the scratch folder is outside it). Sub-agents get `--add-dir` and may read the folder; writers may also write there, to leave files for the orchestrator. The orchestrator hands files on with `files`; agents never see the conversation, only the paths in their brief.
- **Modes.** A round-up has a mode (`sessions.mode`): `auto` (default), `acceptEdits` or `plan`, from the modes its adapter lists (`Adapter.modes`, `GET /api/harnesses`). Sub-agents follow their round-up's mode.
  - **Agents.** They run with `--permission-mode auto` (auto, and plan, where only readers start) or `acceptEdits`, and no blanket Bash allow, so the harness's own checks decide. A change goes to live agent processes at once (`set_permission_mode` control request, not awaited).
  - **Orchestrator.** It always runs as `default` (or Claude Code's `plan` in plan mode), so every edit asks and `decide` settles it; the round-up's mode is for its agents. Its prompt carries the mode's rule, so a change restarts it once it is idle (same conversation, `--resume`).
  - **Plan.** Kelpie enforces it: `spawn_agent` refuses writers, `message_agent` refuses to pick a writer up again, and `muster_agents` refuses. The orchestrator investigates with readers and puts its plan to the person with `ExitPlanMode` (see Approvals).
  - **Accept edits.** Anything the harness asks permission for waits for the person, in the approvals queue (below).
  - **Composer.** The mode chip lists the harness's modes, and Shift+Tab in the box cycles them as in the terminal. Harness and model share one chip whose menu holds per-harness settings. The base branch is a searchable picker. The chips sit in a `@container` and drop their labels as it narrows.
- **Approvals.** Claude Code runs with `--permission-prompt-tool stdio`, so what its rules don't settle comes to Kelpie as a `can_use_tool` control request and waits.
  - **Events.** The adapter logs a `permission.requested` event (tool, a one-line title, the input, the suggested rule, e.g. `Bash(pnpm install)`, and for `ExitPlanMode` the plan) and a `permission.resolved` event: `by` is `person`, `kelpie`, `cancelled` (the CLI's `control_cancel_request` on interrupt) or `expired` (the process ended, or `repair()` after a crash; the resumed agent asks again). Answers go back as `{behavior:'allow', updatedInput, updatedPermissions?}` or `{behavior:'deny', message}`.
  - **Answered by Kelpie first.** A rule the person saved for the round-up (`permission_rules`) allows a matching request at once, and is in every later agent start's `--allowedTools`. Then the `decide` hook: the orchestrator's kelpie tools, its Read/Grep/Glob in its repo checkout, feature branch worktree and scratch folder, and its Edit/Write in its scratch folder are allowed when they ask (paths are taken from its cwd and resolved through links; `..`, dangling links, and Glob patterns that are absolute or go up are refused), its plan goes to the person, anything else it asks for is refused. Agents' requests all go to the person.
  - **The queue.** Open requests are kept in memory per session and streamed per round-up (`approvals` on `/api/events`, with a snapshot on connect); `GET /api/approvals` lists them. `POST /api/approvals {items, decision, message?, remember?, mode?}` answers a batch, each item on its own (one already answered is reported, not fatal). `remember` saves the rule and answers everyone else in the round-up asking the same. An agent waiting shows `needs-approval`.
  - **UI.** A tray above the composer groups requests by rule across agents ("`pnpm install` · Checkout API, Billing · 3 requests") with Allow, Allow for round-up, Deny with a note, Allow all / Deny all, and j/k/a/r/d keys. Each agent's tab shows its own. The sidebar shows a count per round-up and a "Waiting on you" link to `/approvals`, every round-up's queue on one page. Saved rules are listed (and removable) in the tray.
  - **Plans.** In plan mode the orchestrator runs in Claude Code's own plan mode with `ExitPlanMode` (it only works there). Its plan becomes a card in the chat: Approve (switching the round-up to Auto or Accept edits, then allowing it) or Keep planning with a note.
- **Push, not poll.** When a sub-agent goes idle (`activity` busy → false), its orchestrator gets a `<kelpie-notification>` turn with each agent's report. Idles within 1.5s are batched into one turn. Each agent's `notifiedIdx` records which idle it was last told about, and is updated in the same transaction as the outbox write. Sub-agents follow a fixed report shape (Outcome / Details / Files changed / Questions), so notifications stay small. The web chat shows a `source: kelpie` turn as a notice, not as the person speaking.
- **Crash recovery.** The database holds everything needed to carry on: the agent tree, each harness session id, every event, every sent turn (the outbox), `resumePending` and `notifiedIdx`.
  - **Marking.** A graceful shutdown marks every working round-up `resumePending` before stopping the processes, and refuses new sends from then on. After a kill, startup `repair()` marks any round-up whose log ends mid-work.
  - **Resuming.** `Orchestrator.recover()` resumes those round-ups and any with undelivered turns, with `--resume`. Sub-agents go first, within the cap and the writer guard; the rest wait until a slot frees. Each one is re-sent its undelivered turns, or else asked to continue where it left off; orchestrators are also told to re-read `list_agents`. Then any notification still owed (an idle past `notifiedIdx`) is sent.
  - **Lost transcripts.** If a harness session can't be resumed, a fresh one starts. Its system prompt says context was lost and, for an agent, repeats the original brief.
  - **Not exactly-once.** A tool call cut off mid-way may run again on resume.
- **Agent pane.** Each sub-agent keeps a summary in memory (`AgentSummary`: status, a "now" line, its todos, model), updated from its events rather than by reading its log. `GET /api/sessions/:id/agents` lists them, and `/api/events` sends an `agent` event when one changes (at most every 300ms per agent).
  - The pane follows the design canvas. The header's agents button (failed and working counts, then the total) opens the list: a filter, status chips, the fleet map (one square per agent) and the agents grouped by status, Done folded away while others move. Each agent opens in a tab: its status line, "Right now", its todos, its activity and messages (its own KEF stream as steps and bubbles), a message box straight to it, Pause (interrupt) and Full session (`/r/:agentId`).
  - In the chat, `spawn_agent` calls show as agent pills that open the agent's tab, and refusals as a line. Todo lists no longer appear in the chat at all.
  - The plan dock sits above the composer, outside the chat flow: every agent, sorted by what needs attention, with its todos nested under it and a segment per agent in the header bar. The dock collapses to one line (that choice is remembered per browser), and clicking an agent opens its tab. A page with no agents (a sub-agent's own page, or an older round-up) docks its own todo list the same way instead.

