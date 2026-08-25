<!-- batch-tasks-agent:start -->
## Batch tasks

When a prompt contains all four markers `INPUT_DATA:`, `TASK_SPEC:`,
`ID_COLUMN_KEY:`, and `OUTPUT_DIR:`, load and follow
`{{SKILL_PATH}}`. Do not read the full input in the parent context or write
`OUTPUT_DIR/runs/*.json` directly. The installed batch CLI owns validation,
queue state, assignment delivery, result commits, and resume behavior.

This block belongs in {{INSTRUCTION_FILE}} and is Managed by batch-tasks-agent. Re-run `batch-tasks init` to update.
<!-- batch-tasks-agent:end -->
