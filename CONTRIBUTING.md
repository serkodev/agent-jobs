# Contributing to Agent Jobs

This document covers repository development. User installation and job authoring
belong in [README.md](README.md).

## Requirements

- Node.js 20.19+ or 22.12+ for the Vite 8 build toolchain
- pnpm 11.19.0, as declared by `packageManager`

The generated CLI targets Node.js 20 and supports Node.js 20.6 or later at runtime.

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

Return to the repository root and test removal when needed:

```bash
pnpm agent-jobs uninstall playground --yes
```

## Repository structure

The pnpm workspace contains two packages:

- The root `agent-jobs` package owns the installer, host templates, and public CLI.
- `packages/runtime` owns input parsing, JSON Schema validation, persistent batch
  state, assignment handling, and the MCP server.

The dependency direction is intentionally one-way: the installer may depend on the
runtime, while the runtime has no knowledge of Codex, Claude, or installation
paths.

Both packages use TypeScript ESM. Vite library mode produces one Node ESM bundle,
and installation templates are embedded into that bundle as raw text. Vitest is
used for unit and integration tests.

## Runtime model

The installed skill orchestrates the public CLI commands `prepare`, `next`,
`status`, `validate`, and `collect`. Row workers interact only through three MCP
tools:

- `get_assignment`
- `submit_result`
- `report_failure`

`prepare` validates the input, task spec, IDs, and schemas before workers start.
Each assignment uses an opaque capability handle, and `submit_result` validates the
output before publishing it atomically. Every retry uses a fresh worker context.

The isolation model is an application boundary, not an operating-system security
boundary. Native subagents still share the host and underlying filesystem. Agent
Jobs does not currently provide row-level web or repository research, guaranteed
throughput, or a minimum concurrency level.
