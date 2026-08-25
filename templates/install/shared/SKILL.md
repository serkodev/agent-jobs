---
name: agent-jobs
description: Run a resumable, schema-validated batch from INPUT_DATA, TASK_SPEC, ID_COLUMN_KEY, and OUTPUT_DIR prompt markers using isolated {{HOST}} row workers. Use only for marker-defined batch runs, not ordinary one-off data edits.
---

<!-- Managed by agent-jobs. Re-run `agent-jobs init` to update. -->

# Agent Jobs

Orchestrate the batch; never do row work in the parent context. The installed CLI is
the source of truth for validation, queue state, retries, paths, and completion.

## Parse the request

Require exactly one non-empty value for `INPUT_DATA`, `TASK_SPEC`,
`ID_COLUMN_KEY`, and `OUTPUT_DIR`. Optional markers are `RECORDS_PATH`,
`MODEL`, `REASONING_EFFORT`, `MAX_CONCURRENCY`, `MAX_RETRIES`,
`RETRY_INVALID`, `ON_ERROR`, `COLLECT_FORMAT`, `POST_PROCESS_MODEL`, and
`POST_PROCESS_REASONING_EFFORT`.

Reject duplicates and invalid values. Resolve relative paths from the project root.
Marker-free prose is parent/post-processing guidance only and must never be sent to a
row worker.

## Check the installation

Run `{{AGENT_JOBS_CLI}} doctor` before prepare. If its installation check reports
`init_required`, stop and tell the user to run `agent-jobs init`; a skill-only
install cannot register the required agents and MCP server.

## Prepare

Run, adding only flags represented by optional markers:

```text
{{AGENT_JOBS_CLI}} prepare --input-data <INPUT_DATA> --task-spec <TASK_SPEC> \
  --id-column-key <ID_COLUMN_KEY> --output-dir <OUTPUT_DIR> \
  [--records-path <RECORDS_PATH>] [--model <MODEL>] \
  [--reasoning-effort <REASONING_EFFORT>] [--max-concurrency <N>] \
  [--max-retries <N>] [--retry-invalid] [--on-error <POLICY>] \
  [--collect-format <FORMAT>] [--post-process-model <MODEL>] \
  [--post-process-reasoning-effort <EFFORT>]
```

Pass every value as a separately quoted argument. If prepare returns `ok: false`,
report its diagnostics and stop. Otherwise retain the job ID as the execution
session token, along with the resolved worker and postprocessor settings,
concurrency cap, error policy, and collection format. A new prepare for the same
output directory supersedes the previous session and reclaims its uncommitted
assignments. Never independently read or revalidate the full input or task
specification.

## Run isolated workers

Request only the currently available capacity:

```text
{{AGENT_JOBS_CLI}} next --output-dir <OUTPUT_DIR> --job-id <ID> --count <N>
```

{{WORKER_ORCHESTRATION}}

The worker message contains only:

```text
Process exactly one opaque batch assignment.
ASSIGNMENT_HANDLE: <handle>
Use only agent_jobs: get_assignment(handle), then submit_result(handle, result_json)
or report_failure(handle, code, message). Return only an acknowledgement.
```

Never include row data, task contents, other results, or parent prose in that message.
Wait for each wave, then inspect persisted state with `status` or request another
wave with `next`. Retry assignments always use a new worker context. Continue until
there are no pending or active records.

## Validate and collect

Always run:

```text
{{AGENT_JOBS_CLI}} validate --output-dir <OUTPUT_DIR> --job-id <ID>
```

With `ON_ERROR: stop`, validation errors prevent collection and post-processing.
With `continue_successes`, collection may contain only successful valid rows. Unless
the resolved format is `none`, run:

```text
{{AGENT_JOBS_CLI}} collect --output-dir <OUTPUT_DIR> --job-id <ID> --format <FORMAT>
```

If marker-free prose requests synthesis, start one fresh `agent_job_postprocessor` only
after validation and collection. Give it only the collection path, the prose, and the
validation/partial-success statement. Never give it raw run files.

Finish with `status` and report counts, validation, collection path,
post-processing result, and `report.json` without copying all row outputs into the
main response.

## Invariants

- Only `submit_result` may create `runs/*.json`; never repair or replace them.
- Worker final messages are acknowledgements, never row results.
- Never bypass unavailable MCP tools with direct filesystem writes.
- Existing run paths are intentionally existence-only resume checkpoints.
- Run prepare exactly once per parent execution; its job ID fences older workers.
- Do not run two parent orchestrators against the same output directory.
