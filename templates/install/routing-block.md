<!-- agent-jobs:start -->
## Agent Jobs

When a prompt contains all four markers `INPUT_DATA:`, `TASK_SPEC:`,
`ID_COLUMN_KEY:`, and `OUTPUT_DIR:`, load and follow
`{{SKILL_PATH}}`. Do not read the full input in the parent context or access the
`OUTPUT_DIR/.batch/agent-jobs.sqlite` database directly. The installed Agent Jobs
CLI owns validation, queue state, assignment delivery, result commits, and resume
behavior.

This block belongs in {{INSTRUCTION_FILE}} and is Managed by agent-jobs. Re-run `agent-jobs init` to update.
<!-- agent-jobs:end -->
