import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { AgentJobsError } from "../src/errors.js";
import { safeIdFilename } from "../src/input.js";
import { AgentJobsRuntime, type PrepareOptions } from "../src/state.js";
import {
  atomicWriteJson,
  parseStrictJson,
  stringifyStrictJson,
} from "../src/storage.js";

type Lease = { id: string; handle: string };
type Prepared = {
  invocation_id: string;
  output_dir: string;
  counts: Record<string, number>;
  worker: { model: string | null; reasoning_effort: string | null };
};

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

async function fixture(options: {
  rows?: unknown[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  model?: string;
  reasoningEffort?: string;
  rawInput?: string;
} = {}): Promise<{
  root: string;
  inputPath: string;
  specPath: string;
  outputDir: string;
  runtime: AgentJobsRuntime;
}> {
  const root = await mkdtemp(join(tmpdir(), "batch-runtime-test-"));
  temporaryRoots.push(root);
  const inputPath = join(root, "input.json");
  const specPath = join(root, "task.md");
  const outputDir = join(root, "output");
  const inputSchema =
    options.inputSchema ??
    ({
      type: "object",
      properties: {
        id: { type: ["string", "integer"] },
        title: { type: "string", minLength: 1 },
      },
      required: ["id", "title"],
      additionalProperties: false,
    } satisfies Record<string, unknown>);
  const outputSchema =
    options.outputSchema ??
    ({
      type: "object",
      properties: {
        summary: { type: "string", minLength: 1 },
        vote: { type: "string", enum: ["accept", "reject"] },
        details: { type: "object" },
      },
      required: ["summary", "vote"],
      additionalProperties: false,
    } satisfies Record<string, unknown>);
  const metadata: Record<string, unknown> = {
    name: "runtime-test",
    version: 1,
    input_schema: inputSchema,
    output_schema: outputSchema,
  };
  if (options.model !== undefined) metadata.model = options.model;
  if (options.reasoningEffort !== undefined) {
    metadata.reasoning_effort = options.reasoningEffort;
  }
  await writeFile(
    specPath,
    `---\n${stringifyYaml(metadata)}---\n\nProcess exactly one row independently.\n`,
    "utf8",
  );
  await writeFile(
    inputPath,
    options.rawInput ??
      `${stringifyStrictJson(options.rows ?? [{ id: "one", title: "One" }], { pretty: true })}\n`,
    "utf8",
  );
  return {
    root,
    inputPath,
    specPath,
    outputDir,
    runtime: new AgentJobsRuntime({ registryDir: join(root, "registry") }),
  };
}

async function prepare(
  context: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<PrepareOptions> = {},
): Promise<Prepared> {
  return (await context.runtime.prepare({
    inputData: context.inputPath,
    taskSpec: context.specPath,
    idColumnKey: "id",
    outputDir: context.outputDir,
    ...overrides,
  })) as unknown as Prepared;
}

async function nextLeases(
  context: Awaited<ReturnType<typeof fixture>>,
  invocationId: string,
  count = 1,
): Promise<Lease[]> {
  const result = await context.runtime.next(context.outputDir, invocationId, {
    count,
  });
  return result.assignments as Lease[];
}

function result(label: string, nested = false): Record<string, unknown> {
  return {
    summary: `summary-${label}`,
    vote: "accept",
    ...(nested ? { details: { score: label.length } } : {}),
  };
}

async function complete(
  context: Awaited<ReturnType<typeof fixture>>,
  lease: Lease,
  value = result(lease.id),
): Promise<void> {
  await context.runtime.getAssignment(lease.handle);
  await context.runtime.submitResult(lease.handle, value);
}

async function readStrict(path: string): Promise<unknown> {
  return parseStrictJson(await readFile(path, "utf8"));
}

describe("AgentJobsRuntime", () => {
  it("preflights every row before creating state or leasing a worker", async () => {
    const context = await fixture({
      rows: [
        { id: "valid", title: "Valid" },
        { id: "blank", title: "" },
        { id: "missing" },
      ],
    });

    await expect(prepare(context)).rejects.toMatchObject({
      code: "input_validation_failed",
    });
    await expect(readdir(context.outputDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readdir(join(context.root, "registry"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects duplicate canonical IDs and case-insensitive filename collisions", async () => {
    const duplicate = await fixture({
      rows: [
        { id: 1, title: "Integer" },
        { id: "1", title: "String" },
      ],
    });
    await expect(prepare(duplicate)).rejects.toMatchObject({
      code: "duplicate_id",
    });

    const collision = await fixture({
      rows: [
        { id: "Alpha", title: "One" },
        { id: "alpha", title: "Two" },
      ],
    });
    const error = await prepare(collision).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentJobsError);
    expect(error).toMatchObject({ code: "input_validation_failed" });
    expect(stringifyStrictJson((error as AgentJobsError).details)).toContain(
      "id_filename_collision",
    );
  });

  it("rejects lexical float IDs without collapsing them into integer/string IDs", async () => {
    const context = await fixture({
      rawInput:
        '[{"id":1,"title":"Integer"},{"id":"1","title":"String"},{"id":1.0,"title":"Decimal"},{"id":1e0,"title":"Exponent"}]\n',
    });

    const error = await prepare(context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentJobsError);
    expect(error).toMatchObject({ code: "input_validation_failed" });
    const diagnostics = (error as AgentJobsError).details as Array<{
      code: string;
      row?: number;
      rows?: number[];
    }>;
    expect(
      diagnostics
        .filter(({ code }) => code === "invalid_id")
        .map(({ row }) => row),
    ).toEqual([2, 3]);
    expect(
      diagnostics
        .filter(({ code }) => code === "duplicate_id")
        .map(({ rows }) => rows),
    ).toEqual([[0, 1]]);
  });

  it("accepts lexical integer IDs while retaining floats in non-ID fields", async () => {
    const context = await fixture({
      rawInput:
        '[{"id":0,"title":"Zero","score":1.0},{"id":-42,"title":"Negative","score":1e0}]\n',
      inputSchema: {
        type: "object",
        properties: {
          id: { type: ["string", "integer"] },
          title: { type: "string", minLength: 1 },
          score: { type: "number" },
        },
        required: ["id", "title", "score"],
        additionalProperties: false,
      },
    });

    const prepared = await prepare(context);
    const leases = await nextLeases(context, prepared.invocation_id, 2);
    expect(leases.map(({ id }) => id)).toEqual(["0", "-42"]);
    const assignments = await Promise.all(
      leases.map(({ handle }) => context.runtime.getAssignment(handle)),
    );
    expect(assignments.map(({ input }) => input)).toEqual([
      { id: 0, title: "Zero", score: 1 },
      { id: -42, title: "Negative", score: 1 },
    ]);
  });

  it("preserves unsafe integer IDs in a schema-consistent projected assignment", async () => {
    const context = await fixture({
      rawInput:
        '[{"id":9223372036854775807,"title":"Visible","secret":"hidden"}]\n',
    });
    const prepared = await prepare(context);
    const [lease] = await nextLeases(context, prepared.invocation_id);

    expect(lease).toMatchObject({ id: "9223372036854775807" });
    expect(Object.keys(lease ?? {})).toEqual(["id", "handle"]);
    const assignment = await context.runtime.getAssignment(lease!.handle);
    expect(assignment.id).toBe("9223372036854775807");
    expect(assignment.input).toEqual({
      id: 9223372036854775807n,
      title: "Visible",
    });
    expect(assignment.task_spec).toMatchObject({
      name: "runtime-test",
      instructions: "Process exactly one row independently.",
    });
    await expect(
      context.runtime.getAssignment(lease!.handle),
    ).rejects.toMatchObject({ code: "handle_consumed" });
  });

  it("canonicalizes a symlinked OUTPUT_DIR ancestor before persisting state", async () => {
    const context = await fixture();
    const canonicalParent = join(context.root, "canonical-parent");
    const linkedParent = join(context.root, "linked-parent");
    await mkdir(canonicalParent);
    await symlink(canonicalParent, linkedParent, "dir");
    const lexicalOutput = join(linkedParent, "new", "output");
    const expectedOutput = join(
      await realpath(canonicalParent),
      "new",
      "output",
    );

    const prepared = await prepare(context, { outputDir: lexicalOutput });
    expect(prepared.output_dir).toBe(expectedOutput);
    const pointer = (await readStrict(
      join(expectedOutput, ".batch", "current.json"),
    )) as { state_path: string };
    expect(pointer.state_path.startsWith(`${expectedOutput}/.batch/`)).toBe(true);
    const state = (await readStrict(pointer.state_path)) as {
      output_dir: string;
    };
    expect(state.output_dir).toBe(expectedOutput);

    const issued = await context.runtime.next(
      lexicalOutput,
      prepared.invocation_id,
    );
    const [lease] = issued.assignments as Lease[];
    await complete(context, lease!);
    await expect(
      context.runtime.status(lexicalOutput, prepared.invocation_id),
    ).resolves.toMatchObject({ counts: { completed: 1 } });
    expect(await readStrict(join(expectedOutput, "runs", "one.json"))).toEqual(
      result("one"),
    );
  });

  it("does not reveal the canonical ID unless the input schema declares its key", async () => {
    const context = await fixture({
      rows: [{ row_key: "private-id", title: "Visible" }],
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
    });
    const prepared = await prepare(context, { idColumnKey: "row_key" });
    const [lease] = await nextLeases(context, prepared.invocation_id);
    const assignment = await context.runtime.getAssignment(lease!.handle);

    expect(assignment).not.toHaveProperty("id");
    expect(assignment.input).toEqual({ title: "Visible" });
  });

  it("preserves schema-declared __proto__ as data through assignment and collection", async () => {
    const context = await fixture({
      rawInput:
        '[{"id":"one","__proto__":{"polluted":"input-value"}}]\n',
      inputSchema: {
        type: "object",
        properties: Object.fromEntries([
          ["id", { type: "string" }],
          ["__proto__", { type: "object" }],
        ]),
        required: ["id", "__proto__"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: Object.fromEntries([
          ["__proto__", { type: "object" }],
          ["summary", { type: "string" }],
        ]),
        required: ["__proto__", "summary"],
        additionalProperties: false,
      },
    });
    const prepared = await prepare(context);
    const [lease] = await nextLeases(context, prepared.invocation_id);
    const assignment = await context.runtime.getAssignment(lease!.handle);
    const input = assignment.input as Record<string, unknown>;
    expect(Object.hasOwn(input, "__proto__")).toBe(true);
    expect(input.__proto__).toEqual({ polluted: "input-value" });
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);

    const output = Object.fromEntries([
      ["__proto__", { polluted: "output-value" }],
      ["summary", "safe"],
    ]);
    await context.runtime.submitResult(lease!.handle, output);
    const collected = await context.runtime.collect(
      context.outputDir,
      prepared.invocation_id,
      { format: "json" },
    );
    const [record] = (await readStrict(collected.path as string)) as Array<
      Record<string, unknown>
    >;
    expect(Object.hasOwn(record!, "__proto__")).toBe(true);
    expect(record!.__proto__).toEqual({ polluted: "output-value" });
    expect(record!.id).toBe("one");
    expect(Object.getPrototypeOf(record!)).toBe(Object.prototype);
    expect(
      (Object.prototype as { polluted?: unknown }).polluted,
    ).toBeUndefined();
  });

  it("enforces the invocation concurrency cap", async () => {
    const context = await fixture({
      rows: Array.from({ length: 5 }, (_, index) => ({
        id: `row-${index}`,
        title: `${index}`,
      })),
    });
    const prepared = await prepare(context, { maxConcurrency: 2 });
    const first = await nextLeases(context, prepared.invocation_id, 99);
    expect(first).toHaveLength(2);
    await expect(nextLeases(context, prepared.invocation_id, 99)).resolves.toEqual(
      [],
    );

    await complete(context, first[0]!);
    await expect(
      nextLeases(context, prepared.invocation_id, 99),
    ).resolves.toHaveLength(1);
  });

  it("validates results and uses no-clobber atomic publication", async () => {
    const context = await fixture();
    const prepared = await prepare(context);
    const [lease] = await nextLeases(context, prepared.invocation_id);
    await context.runtime.getAssignment(lease!.handle);

    await expect(
      context.runtime.submitResult(lease!.handle, { summary: "missing vote" }),
    ).rejects.toMatchObject({ code: "output_validation_failed" });
    const runPath = join(context.outputDir, "runs", "one.json");
    await expect(readFile(runPath)).rejects.toMatchObject({ code: "ENOENT" });

    await context.runtime.submitResult(lease!.handle, result("one", true));
    expect(await readStrict(runPath)).toEqual(result("one", true));
    expect((await readdir(join(context.outputDir, "runs"))).sort()).toEqual([
      "one.json",
    ]);
    await expect(
      context.runtime.submitResult(lease!.handle, result("replacement")),
    ).rejects.toMatchObject({ code: "invalid_handle" });
  });

  it("reconciles a result committed before an interrupted state update", async () => {
    const context = await fixture();
    const prepared = await prepare(context);
    const [lease] = await nextLeases(context, prepared.invocation_id);
    await context.runtime.getAssignment(lease!.handle);
    await atomicWriteJson(
      join(context.outputDir, "runs", "one.json"),
      result("winner"),
      { noClobber: true },
    );

    const status = await context.runtime.status(
      context.outputDir,
      prepared.invocation_id,
    );
    expect(status.counts).toMatchObject({ completed: 1, active: 0 });
    await expect(
      readFile(join(context.root, "registry", `${lease!.handle}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets a valid commit win when failure is reported before submit updates state", async () => {
    const context = await fixture();
    const prepared = await prepare(context, { maxRetries: 0 });
    const [lease] = await nextLeases(context, prepared.invocation_id);
    await context.runtime.getAssignment(lease!.handle);
    await atomicWriteJson(
      join(context.outputDir, "runs", "one.json"),
      result("committed"),
      { noClobber: true },
    );
    // A stale error can be left by an older invocation using the same output.
    await atomicWriteJson(join(context.outputDir, "errors", "one.json"), {
      code: "stale",
    });

    await expect(
      context.runtime.reportFailure(
        lease!.handle,
        "worker_exit",
        "submit response was interrupted",
      ),
    ).resolves.toMatchObject({
      status: "completed",
      terminal: true,
      reconciled: true,
    });
    await expect(
      context.runtime.status(context.outputDir, prepared.invocation_id),
    ).resolves.toMatchObject({
      counts: { completed: 1, failed: 0, active: 0 },
    });
    await expect(
      readFile(join(context.outputDir, "errors", "one.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(context.root, "registry", `${lease!.handle}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("converges a terminal failure to completed when a valid run arrives late", async () => {
    const context = await fixture();
    const prepared = await prepare(context, { maxRetries: 0 });
    const [lease] = await nextLeases(context, prepared.invocation_id);
    await context.runtime.getAssignment(lease!.handle);
    await expect(
      context.runtime.reportFailure(lease!.handle, "worker_exit", "timed out"),
    ).resolves.toMatchObject({ status: "failed", terminal: true });
    await atomicWriteJson(
      join(context.outputDir, "runs", "one.json"),
      result("late"),
      { noClobber: true },
    );

    await expect(
      context.runtime.validate(context.outputDir, prepared.invocation_id),
    ).resolves.toMatchObject({
      valid: true,
      counts: { valid: 1, failed: 0, missing: 0 },
    });
    const status = await context.runtime.status(
      context.outputDir,
      prepared.invocation_id,
    );
    expect(status).toMatchObject({ counts: { completed: 1, failed: 0 } });
    expect(status.rows).toEqual([
      { id: "one", status: "completed", attempts: 1 },
    ]);
    await expect(
      readFile(join(context.outputDir, "errors", "one.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("issues one fresh retry and then writes a structured terminal error", async () => {
    const context = await fixture();
    const prepared = await prepare(context, { maxRetries: 1 });
    const [first] = await nextLeases(context, prepared.invocation_id);
    await context.runtime.getAssignment(first!.handle);
    await expect(
      context.runtime.reportFailure(first!.handle, "worker_error", "first"),
    ).resolves.toMatchObject({ terminal: false, status: "pending", attempts: 1 });

    const [second] = await nextLeases(context, prepared.invocation_id);
    expect(second!.handle).not.toBe(first!.handle);
    await context.runtime.getAssignment(second!.handle);
    await expect(
      context.runtime.reportFailure(second!.handle, "worker_error", "second"),
    ).resolves.toMatchObject({ terminal: true, status: "failed", attempts: 2 });
    expect(await readStrict(join(context.outputDir, "errors", "one.json"))).toMatchObject(
      { id: "one", code: "worker_error", message: "second", attempts: 2 },
    );
  });

  it("skips existing output by existence and optionally archives invalid cache", async () => {
    const skipped = await fixture();
    await mkdir(join(skipped.outputDir, "runs"), { recursive: true });
    await writeFile(
      join(skipped.outputDir, "runs", "one.json"),
      '{"from":"old spec"}\n',
      "utf8",
    );
    const first = await prepare(skipped);
    expect(first.counts).toMatchObject({ skipped_invalid: 1, pending: 0 });
    await expect(
      nextLeases(skipped, first.invocation_id, 10),
    ).resolves.toEqual([]);
    const validation = await skipped.runtime.validate(
      skipped.outputDir,
      first.invocation_id,
    );
    expect(validation).toMatchObject({ valid: false });

    const retried = await fixture();
    await mkdir(join(retried.outputDir, "runs"), { recursive: true });
    await writeFile(
      join(retried.outputDir, "runs", "one.json"),
      '{"invalid":true}\n',
      "utf8",
    );
    const second = await prepare(retried, { retryInvalid: true });
    expect(second.counts).toMatchObject({ pending: 1, skipped: 0 });
    const archiveGroups = await readdir(
      join(retried.outputDir, "history", "invalid"),
    );
    expect(archiveGroups).toHaveLength(1);
    expect(
      await readStrict(
        join(
          retried.outputDir,
          "history",
          "invalid",
          archiveGroups[0]!,
          "one.json",
        ),
      ),
    ).toEqual({ invalid: true });
  });

  it("resumes a new invocation strictly from committed outputs", async () => {
    const context = await fixture({
      rows: [
        { id: "done", title: "Done" },
        { id: "remaining", title: "Remaining" },
      ],
    });
    const first = await prepare(context);
    const [lease] = await nextLeases(context, first.invocation_id);
    await complete(context, lease!);

    const resumed = await prepare(context);
    expect(resumed.invocation_id).not.toBe(first.invocation_id);
    expect(resumed.counts).toMatchObject({ skipped_valid: 1, pending: 1 });
    expect(await nextLeases(context, resumed.invocation_id, 10)).toMatchObject([
      { id: "remaining" },
    ]);
  });

  it("collects in input order and encodes unsafe filenames deterministically", async () => {
    const ids = ["first", "unsafe/id", "last"];
    const context = await fixture({
      rows: ids.map((id) => ({ id, title: id })),
    });
    const prepared = await prepare(context);
    const leases = await nextLeases(context, prepared.invocation_id, 3);
    for (const lease of leases.toReversed()) {
      await complete(context, lease, result(lease.id, true));
    }
    const collected = await context.runtime.collect(
      context.outputDir,
      prepared.invocation_id,
      { format: "json" },
    );
    const records = (await readStrict(collected.path as string)) as Array<{
      id: string;
    }>;
    expect(records.map((record) => record.id)).toEqual(ids);
    expect(
      await readStrict(
        join(
          context.outputDir,
          "runs",
          `${safeIdFilename("unsafe/id")}.json`,
        ),
      ),
    ).toMatchObject({ summary: "summary-unsafe/id" });
  });

  it("writes deterministic JSONL, CSV, and none collections", async () => {
    const context = await fixture({
      rows: [
        { id: "one", title: "One" },
        { id: "two", title: "Two" },
      ],
    });
    const prepared = await prepare(context);
    for (const lease of await nextLeases(context, prepared.invocation_id, 2)) {
      await complete(context, lease, result(lease.id, true));
    }

    const jsonl = await context.runtime.collect(
      context.outputDir,
      prepared.invocation_id,
      { format: "jsonl" },
    );
    const lines = (await readFile(jsonl.path as string, "utf8"))
      .trim()
      .split("\n")
      .map((line) => parseStrictJson(line) as { id: string });
    expect(lines.map((line) => line.id)).toEqual(["one", "two"]);

    const csv = await context.runtime.collect(
      context.outputDir,
      prepared.invocation_id,
      { format: "csv" },
    );
    const csvText = await readFile(csv.path as string, "utf8");
    expect(csvText).toContain("id,summary,vote,details");
    expect(csvText).toContain('"{""score"":3}"');

    await expect(
      context.runtime.collect(context.outputDir, prepared.invocation_id, {
        format: "none",
      }),
    ).resolves.toMatchObject({ path: null, count: 2 });
  });

  it("blocks failed collection by default and can continue with successes", async () => {
    const context = await fixture({
      rows: [
        { id: "ok", title: "OK" },
        { id: "bad", title: "Bad" },
      ],
    });
    const stopped = await prepare(context, { maxRetries: 0 });
    const [ok, bad] = await nextLeases(context, stopped.invocation_id, 2);
    await complete(context, ok!);
    await context.runtime.reportFailure(
      bad!.handle,
      "worker_failed",
      "no result",
    );
    await expect(
      context.runtime.collect(context.outputDir, stopped.invocation_id, {
        format: "json",
      }),
    ).rejects.toMatchObject({ code: "batch_failed" });

    const continuing = await fixture({
      rows: [
        { id: "ok", title: "OK" },
        { id: "bad", title: "Bad" },
      ],
    });
    const partial = await prepare(continuing, {
      maxRetries: 0,
      onError: "continue_successes",
    });
    const [partialOk, partialBad] = await nextLeases(
      continuing,
      partial.invocation_id,
      2,
    );
    await complete(continuing, partialOk!);
    await continuing.runtime.reportFailure(
      partialBad!.handle,
      "worker_failed",
      "no result",
    );
    const collected = await continuing.runtime.collect(
      continuing.outputDir,
      partial.invocation_id,
      { format: "json" },
    );
    expect(collected).toMatchObject({ count: 1, partial: true });
  });

  it("applies model precedence and clears spec effort on model override", async () => {
    const fromSpec = await fixture({
      model: "small-model",
      reasoningEffort: "high",
    });
    const specPrepared = await prepare(fromSpec);
    expect(specPrepared.worker).toEqual({
      model: "small-model",
      reasoning_effort: "high",
    });

    const override = await fixture({
      model: "small-model",
      reasoningEffort: "high",
    });
    const overridden = await prepare(override, { model: "strong-model" });
    expect(overridden.worker).toEqual({
      model: "strong-model",
      reasoning_effort: null,
    });
  });

  it("doctor reports the Node 20.6 runtime floor", async () => {
    const context = await fixture();
    const diagnosis = await context.runtime.doctor({ taskSpec: context.specPath });
    const nodeCheck = (diagnosis.checks as Array<Record<string, unknown>>).find(
      (check) => check.name === "node",
    );

    expect(nodeCheck).toEqual({
      name: "node",
      ok: true,
      detail: { version: process.versions.node, required: ">=20.6" },
    });
  });

  it("rejects symlinked managed output paths and registry entries", async () => {
    const context = await fixture();
    await mkdir(context.outputDir);
    const outside = join(context.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(context.outputDir, "runs"), "dir");
    await expect(prepare(context)).rejects.toMatchObject({
      code: "unsafe_output_path",
      details: { reason: "symlink" },
    });

    const registryContext = await fixture();
    const prepared = await prepare(registryContext);
    const [lease] = await nextLeases(
      registryContext,
      prepared.invocation_id,
    );
    const registryPath = join(
      registryContext.root,
      "registry",
      `${lease!.handle}.json`,
    );
    const outsideRegistry = join(registryContext.root, "outside-registry.json");
    await writeFile(outsideRegistry, await readFile(registryPath));
    await unlink(registryPath);
    await symlink(outsideRegistry, registryPath);
    await expect(
      registryContext.runtime.getAssignment(lease!.handle),
    ).rejects.toMatchObject({
      code: "unsafe_output_path",
      details: { reason: "symlink" },
    });
  });
});
