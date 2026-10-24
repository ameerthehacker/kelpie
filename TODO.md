# TODO

- [ ] **Kelpie-owned task graph.** Replace the orchestrator's Claude Code todo tools (TaskCreate/TaskUpdate) with Kelpie MCP tools (`create_task`, `update_task`, `assign`) stored in the DB. Tasks then link to their agents, survive any crash or failed resume, and can carry dependencies, so the daemon (code, not the LLM) starts B when A finishes. The orchestrator plans; the daemon schedules.
- [ ] **Verification before accepting work.** Let the orchestrator spawn a read-only reviewer agent that checks a writer's report against the actual diff, so self-reported "done" isn't taken on trust.
- [ ] **Rate-limit-aware pacing.** `spawn_agent` queues instead of refusing when the harness's usage window passes ~80% (from the `rate_limit` data already in `harness_usage`), and starts queued agents as the window frees up.
