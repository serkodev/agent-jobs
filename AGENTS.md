# Batch tasks project instructions

When a user prompt contains all four markers `INPUT_DATA:`, `TASK_SPEC:`,
`ID_COLUMN_KEY:`, and `OUTPUT_DIR:`, treat it as a batch-tasks request.

- Load and follow `.agents/skills/batch-tasks/SKILL.md` before doing any batch work.
- Do not read the full input into the parent conversation, enumerate rows manually, or
  send row data in a subagent spawn message.
- Use the project CLI for input/spec validation and bookkeeping, native subagents for
  row work, and the `batch_tasks` MCP tools for assignment delivery and commits.
- Keep every row worker in a fresh context. Never share another worker's result,
  comments, or conversation with it.
- Treat existing `OUTPUT_DIR/runs/<safe-id>.json` files according to the skill's
  existence-only resume policy. Never overwrite them directly.

For ordinary repository development that is not a batch run, use Node.js 20.6+ and pnpm,
keep unrelated user files intact, and run the relevant tests after changes.
