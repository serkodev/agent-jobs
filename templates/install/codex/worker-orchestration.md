For every returned handle, spawn a separate native subagent with
`fork_turns: "none"` and custom role `agent_job_worker`. Apply resolved model and
reasoning settings only when non-null. If custom roles are unavailable, use a fresh
generic context and explicitly restrict it to the three `agent_jobs` MCP tools.
