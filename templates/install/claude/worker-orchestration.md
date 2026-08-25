For every returned handle, invoke a separate Agent using
`subagent_type: batch_worker`. Each invocation must be a fresh context. Apply the
resolved model only when non-null; do not reuse or resume a worker for another row.
