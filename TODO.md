# TODO

- [ ] **Kelpie-owned task graph.** Replace the orchestrator's Claude Code todo tools (TaskCreate/TaskUpdate) with Kelpie MCP tools (`create_task`, `update_task`, `assign`) stored in the DB. Tasks then link to their agents, survive any crash or failed resume, and can carry dependencies, so the daemon (code, not the LLM) starts B when A finishes. The orchestrator plans; the daemon schedules.
- [ ] **Verification before accepting work.** Let the orchestrator spawn a read-only reviewer agent that checks a writer's report against the actual diff, so self-reported "done" isn't taken on trust.
- [ ] **Rate-limit-aware pacing.** `spawn_agent` queues instead of refusing when the harness's usage window passes ~80% (from the `rate_limit` data already in `harness_usage`), and starts queued agents as the window frees up.

## Direction: a feature and todo manager (decided 2026-10-24)

A round-up becomes a **feature** with a branch, a PR and a status (planning → in progress → in review → merged). Build in this order:

- [ ] **Todos stored by Kelpie.** Todos live in the DB per feature and can be assigned to agents. The user edits them in the UI; the orchestrator uses `create_todo` / `update_todo` tools. This replaces the plan dock and covers the "Kelpie-owned task graph" item above.
- [ ] **One worktree per feature.** Created automatically with its branch. The feature's agents run in it, and it is cleaned up when the PR merges or the feature is archived.
- [ ] **Diff view.** Each feature shows its changes against the base branch, uncommitted work included.
- [ ] **PRs.** Either "Open PR" (push the branch, open a draft with `gh`, description built from the todos) or link an existing PR by URL. Show the PR's state and checks.
