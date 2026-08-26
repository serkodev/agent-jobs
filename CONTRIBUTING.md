# Contributing to Agent Jobs

This document covers repository development. User installation and job authoring
belong in [README.md](README.md).

## Requirements

- Node.js 22.13+ (the first Node 22 release where `node:sqlite` needs no flag)
- pnpm 11.19.0, as declared by `packageManager`

The generated CLI targets Node.js 22 and supports Node.js 22.13 or later at runtime.

## Set up the repository

```bash
pnpm install --frozen-lockfile
```

Keep changes scoped to the feature being worked on and preserve unrelated files in
the working tree.

## Build and test

Run the checks relevant to your change:

```bash
pnpm lint
pnpm db:check
pnpm typecheck
pnpm test
pnpm test:bundle
```

`pnpm test:bundle` builds the distributable and verifies that it can run without
workspace dependencies. A normal production build is:

```bash
pnpm build
```

## Test a local installation

Build the CLI, then initialize a disposable project from the repository:

```bash
pnpm build
pnpm agent-jobs init playground --yes
```

The `playground/` directory is ignored by Git. Run diagnostics from inside the
installed project:

```bash
cd playground
node ../dist/agent-jobs.mjs doctor
```

## Repository structure

The pnpm workspace contains two packages:

- The root `agent-jobs` package owns the installer, host templates, and public CLI.
- `packages/runtime` owns input parsing, field-DSL validation, persistent batch
  state, assignment handling, and the MCP server.

The dependency direction is intentionally one-way: the installer may depend on the
runtime, while the runtime has no knowledge of Codex, Claude, or installation
paths.

Both packages use TypeScript ESM. Vite library mode produces one Node ESM bundle,
and installation templates are embedded into that bundle as raw text. Vitest is
used for unit and integration tests.

## Database migrations

`packages/runtime/src/database-schema.ts` is the source of truth for tables,
indexes, foreign keys, and check constraints. After changing it, generate and
embed a migration:

```bash
pnpm db:generate
```

Review and commit the generated migration, snapshot, and embedded JSON manifest.
`pnpm db:check` fails when the manifest no longer matches the migration SQL. The
manifest lets Vite include every migration in the standalone CLI bundle without
requiring migration files in the user's project.

## Runtime model

The installed skill orchestrates the public CLI commands `prepare`, `next`,
`status`, `validate`, and `collect`. Row workers interact only through three MCP
tools:

- `get_assignment`
- `submit_result`
- `report_failure`

`prepare` validates the input, task spec, IDs, and schemas before workers start.
Each assignment uses an opaque capability handle, and `submit_result` validates the
output before committing the result and queue transition in one SQLite
transaction. Drizzle owns the typed schema and queries, while Node's built-in
`node:sqlite` module provides the SQLite driver without another runtime package.
Versioned Drizzle migrations create and upgrade the database. Every retry uses a
fresh worker context.

The database stores each ID with its exact input hash, and results with both the
input hash and task execution hash. Cache reuse requires all of them to match. The
job ID identifies the single execution session for an output directory. A later
`prepare` transactionally supersedes the previous session and revokes any remaining
assignment handles before new work is issued. `validate` and `collect` use one
consistent database snapshot, while `report.json` and `collected.*` are exports
rather than authoritative state.

The isolation model is an application boundary, not an operating-system security
boundary. Native subagents still share the host and underlying filesystem. Agent
Jobs does not currently provide row-level web or repository research, guaranteed
throughput, or a minimum concurrency level.
