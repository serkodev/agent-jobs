# Agent Jobs

Run the same structured task across many records with native Codex or Claude
workers.

Agent Jobs solves the coordination problems that appear when a normal agent prompt
turns into a batch workload: shared context grows, results get mixed together,
progress is easy to lose, and concurrent workers can overwrite one another. It
turns the dataset into a schema-validated agent job, gives every input record an
isolated worker assignment, and stores progress on disk so interrupted runs can
resume safely.

Key benefits:

- A fresh agent context for every record
- JSON Schema validation for both inputs and outputs
- Bounded concurrency and automatic retries
- Durable, resumable progress with atomic result writes
- Small parent context: workers receive only their assigned record
- Native project or global setup for Codex and Claude

## Install

Agent Jobs requires Node.js 20.6 or later. The recommended command for a registry
release is:

```bash
npx agent-jobs init
```

The package is currently private and not yet available from the public npm
registry. Until it is published, contributors can use the local setup described in
[CONTRIBUTING.md](CONTRIBUTING.md).

By default, `init` configures the current project for both Codex and Claude. You can
choose a path or a single host:

```bash
# Configure another project
npx agent-jobs init ./my-project

# Configure only Codex
npx agent-jobs init ./my-project --target codex

# Configure Claude globally for the current user
npx agent-jobs init --global --target claude
```

The installer shows the target path and asks for confirmation. Use `--yes` in a
non-interactive environment. Use `--force` only when you intentionally want to
replace managed files that have been edited since installation.

Restart Codex or Claude after installation so it discovers the new skill, agents,
and MCP configuration.

To check or remove the installation:

```bash
npx agent-jobs doctor
npx agent-jobs uninstall
```

## Create a job

A job needs three things:

1. An input file containing the records
2. A Markdown task spec defining the worker instruction and schemas
3. A prompt containing the four required Agent Jobs markers

### 1. Create the input file

Agent Jobs accepts JSON, JSONL, CSV, and YAML. Each record must have a stable,
unique string or integer ID.

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
input_schema:
  type: object
  additionalProperties: false
  required: [id, title]
  properties:
    id:
      type: string
    title:
      type: string
output_schema:
  type: object
  additionalProperties: false
  required: [decision, reason]
  properties:
    decision:
      type: string
      enum: [accept, reject]
    reason:
      type: string
---

Review the proposal title. Return a decision and a concise reason.
```

The frontmatter supports these fields:

| Field | Required | Purpose |
| --- | --- | --- |
| `name` | Yes | Stable name for the task |
| `version` | No | Task definition version; default: `1` |
| `input_schema` | Yes | JSON Schema for each input record |
| `output_schema` | Yes | JSON Schema for each worker result |
| `description` | No | Human-readable task description |
| `model` | No | Default worker model |
| `reasoning_effort` | No | Default worker reasoning effort |

Workers receive only fields declared in `input_schema.properties`. Invalid inputs
are rejected before any worker starts.

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
| `RETRY_INVALID` | No | Set to `true` to archive and rerun an existing invalid result |
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
.agent-jobs/install-manifest.json

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

The installer tracks its managed changes in `.agent-jobs/install-manifest.json` so
they can be checked and removed safely. During execution, `.agent-jobs/handles/`
stores temporary local assignment capabilities; it is not part of the job output.

Each run stores durable state under the selected `OUTPUT_DIR`:

```text
proposal-results/
  runs/<safe-record-id>.json  # Valid task outputs
  errors/<safe-record-id>.json # Structured worker failures
  history/invalid/            # Invalid results archived for retry
  report.json                 # Final validation report
  collected.json              # Optional combined output
  .batch/jobs/<job-id>.json   # Queue and resume state
```

Completed records are reused when the same output directory is resumed. Do not
edit `runs/` directly or run two parent agents against the same `OUTPUT_DIR` at the
same time.

## Contributing

Development setup, architecture, build commands, and test guidance live in
[CONTRIBUTING.md](CONTRIBUTING.md).
