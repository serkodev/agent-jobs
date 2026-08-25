For every returned handle, invoke a separate Agent using
`subagent_type: agent_job_worker`. Each worker run must be a fresh context. Apply the
resolved model only when non-null; do not reuse or resume a worker for another row.
