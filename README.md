# Agent Jobs

Run the same structured task across many records with native Codex or Claude
workers.

Agent Jobs solves the coordination problems that appear when a normal agent prompt
turns into a batch workload: shared context grows, results get mixed together,
progress is easy to lose, and concurrent workers can overwrite one another. It
turns the dataset into a schema-validated agent job, gives every input record an
isolated worker assignment, and stores progress transactionally in SQLite so
interrupted runs can resume safely.

Key benefits:

- A fresh agent context for every record
- One small, shared field-schema DSL for inputs, outputs, and MCP tools
- Bounded concurrency and automatic retries
- Durable, resumable progress with transactional result commits
- Small parent context: workers receive only their assigned record
- Native project or global setup for Codex and Claude

## Install

Agent Jobs requires Node.js 22.13 or later. The recommended command for a registry
release is:

```bash
npx agent-jobs init
```

The package is currently private and not yet available from the public npm
registry. Until it is published, contributors can use the local setup described in
[CONTRIBUTING.md](CONTRIBUTING.md).

In an interactive terminal, `init` asks for any location, path, or agent targets
that were not provided as arguments. Agent targets use a checkbox prompt with no
initial selection, so the user explicitly chooses Codex, Claude, or both. Values
supplied on the command line are not asked again. The resolved choices are shown in
a preview before files are changed.

The location prompt starts at the current project. You can also provide a path or a
single host directly:

```bash
# Configure another project
npx agent-jobs init ./my-project

# Configure only Codex
npx agent-jobs init ./my-project --target codex

# Configure Claude globally for the current user
npx agent-jobs init --global --target claude
```

Use `--yes` to skip the final confirmation. In a non-interactive environment,
`--yes` is required; omitted values use the current project and both agent hosts.
Use `--force` only when you intentionally want to replace managed files that have
been edited since installation.

Restart Codex or Claude after installation so it discovers the new skill, agents,
and MCP configuration.

To check the installation:

```bash
npx agent-jobs doctor
```

## Create a job

A job needs three things:

1. An input file containing the records
2. A Markdown task spec defining the worker instruction and schemas
3. A prompt containing the four required Agent Jobs markers

### 1. Create the input file

Agent Jobs accepts JSON, JSONL, CSV, and YAML. Each record must have a stable,
unique string or integer ID.

JSON and YAML numeric values are preserved without IEEE-754 rounding: safe values
remain normal JavaScript numbers, integers beyond the safe range use `bigint`, and
high-precision decimals/exponents use a lossless numeric representation throughout
validation, worker delivery, persistence, and JSON/JSONL collection.

`proposals.json`:

```json
[
  { "id": "proposal-1", "title": "Practical TypeScript" },
  { "id": "proposal-2", "title": "Reliable Node.js Services" }
]
```

### 2. Create the task spec

The YAML frontmatter is the machine-readable contract. The Markdown body is the
only instruction sent to each row worker.

`review-proposal.md`:

```markdown
---
name: review-proposal
version: 1
input:
  loose: false
  schema:
    id: string
    title: string
output:
  loose: false
  schema:
    decision:
      type: string
      enum: [accept, reject]
    reason: string
---

Review the proposal title. Return a decision and a concise reason.
```

The frontmatter supports these fields:

| Field | Required | Purpose |
| --- | --- | --- |
| `output` | Yes | Output field schema and passthrough setting |
| `input` | No | Input field schema and passthrough setting |
| `name` | No | Stable task name; defaults to the spec filename without its final extension |
| `version` | No | Task definition version; default: `1` |
| `description` | No | Human-readable task description |
| `model` | No | Default worker model |
| `reasoning_effort` | No | Default worker reasoning effort |

<details>
<summary>Input/output schema DSL reference</summary>

Each input or output `schema` maps field names to their types. Declared fields are
required by default; add `optional: true` only when a field may be omitted. Simple
fields use the short form shown above, such as `id: string`.

Every field has a `type`: `string`, `integer`, `number`, `boolean`, `null`,
`object`, or `array`. A type array, such as `[string, integer]` or
`[string, null]`, defines a union. `integer` accepts arbitrarily large integers
without rounding; `number` accepts both integers and floating-point JSON numbers,
including losslessly parsed decimals.

When a field needs no other options, its type can be written directly. These two
forms are equivalent:

```yaml
id: string
```

```yaml
id:
  type: string
```

Union types can use the same shorthand:

```yaml
id: [string, integer]
```

This is equivalent to `id: { type: [string, integer] }`. The shorthand also works
inside nested `properties` and for array `items`.

The DSL supports these optional constraints:

| Applies to | Keys |
| --- | --- |
| Every field | `optional`, `description`, `enum` |
| `string` | `minLength`, `maxLength`, `pattern` |
| `integer`, `number` | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` |
| `array` | `items`, `minItems`, `maxItems`, `uniqueItems` |
| `object` | `properties`, `loose`, `minProperties`, `maxProperties` |

Nested `properties` use the same field definitions. Objects are strict by default;
set their `loose: true` to accept undeclared nested fields. Unknown DSL keys and
constraints used with an incompatible type are rejected as spec errors instead of
being silently ignored.

Within an explicit top-level `input` or `output`, `loose` also defaults to `false`:
undeclared input fields are omitted and undeclared output fields are rejected. Set
the corresponding `loose: true` to pass those fields through.

The entire `input` block is optional. Omitting it is equivalent to
`input: { loose: true, schema: {} }`, so every input field is passed to the worker
and participates in its cache identity. This is useful when the task instructions
validate arbitrary input. `output` is always required. Because every input and
output schema is already an object record, no outer object boilerplate is needed.
The same Valibot-parsed DSL validates task data and MCP tool arguments. Invalid
schema-constrained inputs are rejected before any worker starts.

</details>

### 3. Send the prompt

After restarting Codex or Claude, send a prompt like this:

```text
Review every proposal. When all records are complete, summarize the accept and
reject counts and the main reasons.

INPUT_DATA: proposals.json
TASK_SPEC: review-proposal.md
ID_COLUMN_KEY: id
OUTPUT_DIR: proposal-results/
MAX_CONCURRENCY: 4
COLLECT_FORMAT: json
```

The first four markers activate Agent Jobs. Text outside the markers tells the
parent agent how to present or post-process the completed batch; it is not added to
each worker's task.

## Prompt configuration

| Marker | Required | Purpose |
| --- | --- | --- |
| `INPUT_DATA` | Yes | Path to a JSON, JSONL, CSV, or YAML input file |
| `TASK_SPEC` | Yes | Path to the Markdown task spec |
| `ID_COLUMN_KEY` | Yes | Field containing each record's unique ID |
| `OUTPUT_DIR` | Yes | Persistent output directory for this batch |
| `RECORDS_PATH` | No | JSON Pointer when records are not the top-level JSON/YAML list |
| `MODEL` | No | Model used by row workers |
| `REASONING_EFFORT` | No | Reasoning effort used by row workers |
| `MAX_CONCURRENCY` | No | Maximum workers to run at once |
| `MAX_RETRIES` | No | Retries after the first failed attempt; default: `1` |
| `RETRY_INVALID` | No | Set to `true` to ignore and rerun a cached result that fails schema or integrity validation |
| `ON_ERROR` | No | `stop` (default) or `continue_successes` |
| `COLLECT_FORMAT` | No | `none`, `json`, `jsonl`, or `csv`; default: `json` |
| `POST_PROCESS_MODEL` | No | Model used for the optional final synthesis |
| `POST_PROCESS_REASONING_EFFORT` | No | Reasoning effort for final synthesis |

Worker model settings use this precedence:

```text
prompt marker > task spec > parent agent setting
```

## Files and output

A project installation adds only host integration files:

```text
# Codex
AGENTS.md
.agents/skills/agent-jobs/
.codex/agents/agent_job_worker.toml
.codex/agents/agent_job_postprocessor.toml
.codex/config.toml

# Claude
CLAUDE.md
.claude/skills/agent-jobs/
.claude/agents/agent_job_worker.md
.claude/agents/agent_job_postprocessor.md
.claude/settings.local.json
.mcp.json
```

The installer does not write an installation manifest. During execution,
`.agent-jobs/handles/` stores temporary local assignment capabilities; it is not
part of the job output.

Each run stores durable state under the selected `OUTPUT_DIR`:

```text
proposal-results/
  .batch/agent-jobs.sqlite  # Authoritative jobs, rows, leases, and results
  report.json              # Exported final validation report
  collected.json           # Optional combined output
```

Each database row keeps the canonical record ID together with its input hash, and
each result keeps that input hash plus the task execution hash. A completed result
is reused only when all three match, so changing a row without changing its ID does
not reuse stale output.

SQLite transactions serialize leasing, retries, result insertion, and status
updates. `submit_result` inserts the result and marks its row complete in one
transaction; there is no intermediate result file for the runtime to reconcile.
`validate` and `collect` read a consistent database snapshot and explicitly report
every missing, failed, invalid, and valid row. The JSON report and collected file
are exports, not queue state.

Each `prepare` creates a new job ID that also acts as the execution session token.
When an interrupted output directory is prepared again, the prior session is
superseded, its active handles are revoked, and uncommitted records are issued
again under the new job ID. A result committed before interruption remains the
authoritative checkpoint and is not repeated. If two parents prepare the same
`OUTPUT_DIR`, the later transaction supersedes the earlier session.

## Contributing

Development setup, architecture, build commands, and test guidance live in
[CONTRIBUTING.md](CONTRIBUTING.md).
