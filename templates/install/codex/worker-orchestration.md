For every returned handle, spawn a separate native subagent with
`fork_turns: "none"` and custom role `batch_worker`. Apply resolved model and
reasoning settings only when non-null. If custom roles are unavailable, use a fresh
generic context and explicitly restrict it to the three `batch_tasks` MCP tools.
