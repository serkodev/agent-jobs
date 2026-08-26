import type { SQLInputValue } from 'node:sqlite';
import type { PrepareOptions } from '../src/state.js';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { stringify as stringifyYaml } from 'yaml';
import { AgentJobsError } from '../src/errors.js';
import { isPreciseNumber } from '../src/numbers.js';
import { AgentJobsRuntime } from '../src/state.js';
import {
  parseStrictJson,
  stringifyStrictJson,
} from '../src/storage.js';

interface Lease { id: string; handle: string }
interface Prepared {
  job_id: string;
  session_status: string;
  superseded_job_id?: string;
  reclaimed_assignments?: number;
  output_dir: string;
  database: string;
  source_hash: string;
  task_hash: string;
  execution_hash: string;
  counts: Record<string, number>;
  worker: { model: string | null; reasoning_effort: string | null };
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(path =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

async function fixture(options: {
  rows?: unknown[];
  inputFields?: Record<string, unknown>;
  inputLoose?: boolean;
  omitInput?: boolean;
  omitName?: boolean;
  specFileName?: string;
  outputFields?: Record<string, unknown>;
  outputLoose?: boolean;
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
  const root = await mkdtemp(join(tmpdir(), 'batch-runtime-test-'));
  temporaryRoots.push(root);
  const inputPath = join(root, 'input.json');
  const specPath = join(root, options.specFileName ?? 'task.md');
  const outputDir = join(root, 'output');
  const inputFields
    = options.inputFields
      ?? ({
        id: { type: ['string', 'integer'] },
        title: { type: 'string', minLength: 1 },
      } satisfies Record<string, unknown>);
  const outputFields
    = options.outputFields
      ?? ({
        summary: { type: 'string', minLength: 1 },
        vote: {
          type: 'string',
          enum: ['accept', 'reject'],
        },
        details: {
          type: 'object',
          optional: true,
          properties: { score: { type: 'integer' } },
        },
      } satisfies Record<string, unknown>);
  const metadata: Record<string, unknown> = {
    ...(options.omitName ? {} : { name: 'runtime-test' }),
    version: 1,
    output: {
      ...(options.outputLoose === undefined ? {} : { loose: options.outputLoose }),
      schema: outputFields,
    },
  };
  if (!options.omitInput) {
    metadata.input = {
      ...(options.inputLoose === undefined ? {} : { loose: options.inputLoose }),
      schema: inputFields,
    };
  }
  if (options.model !== undefined)
    metadata.model = options.model;
  if (options.reasoningEffort !== undefined) {
    metadata.reasoning_effort = options.reasoningEffort;
  }
  await writeFile(
    specPath,
    `---\n${stringifyYaml(metadata)}---\n\nProcess exactly one row independently.\n`,
    'utf8',
  );
  await writeFile(
    inputPath,
    options.rawInput
    ?? `${stringifyStrictJson(options.rows ?? [{ id: 'one', title: 'One' }], { pretty: true })}\n`,
    'utf8',
  );
  return {
    root,
    inputPath,
    specPath,
    outputDir,
    runtime: new AgentJobsRuntime({ registryDir: join(root, 'registry') }),
  };
}

async function prepare(
  context: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<PrepareOptions> = {},
): Promise<Prepared> {
  return (await context.runtime.prepare({
    inputData: context.inputPath,
    taskSpec: context.specPath,
    idColumnKey: 'id',
    outputDir: context.outputDir,
    ...overrides,
  })) as unknown as Prepared;
}

async function nextLeases(
  context: Awaited<ReturnType<typeof fixture>>,
  jobId: string,
  count = 1,
): Promise<Lease[]> {
  const result = await context.runtime.next(context.outputDir, jobId, {
    count,
  });
  return result.assignments as Lease[];
}

function result(label: string, nested = false): Record<string, unknown> {
  return {
    summary: `summary-${label}`,
    vote: 'accept',
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
  return parseStrictJson(await readFile(path, 'utf8'));
}

async function sqliteRows(
  database: string,
  sql: string,
  args: SQLInputValue[] = [],
): Promise<Array<Record<string, unknown>>> {
  const client = new DatabaseSync(database);
  try {
    const statement = client.prepare(sql);
    if (!/^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(sql)) {
      statement.run(...args);
      return [];
    }
    return statement.all(...args).map(row => ({ ...row }));
  } finally {
    client.close();
  }
}

describe('agentJobsRuntime', () => {
  it('preflights every row before creating state or leasing a worker', async () => {
    const context = await fixture({
      rows: [
        { id: 'valid', title: 'Valid' },
        { id: 'blank', title: '' },
        { id: 'missing' },
      ],
    });

    await expect(prepare(context)).rejects.toMatchObject({
      code: 'input_validation_failed',
    });
    await expect(readdir(context.outputDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readdir(join(context.root, 'registry'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('stores field configs without synthesizing another root schema', async () => {
    const context = await fixture();
    const prepared = await prepare(context);
    const [row] = await sqliteRows(
      prepared.database,
      'SELECT state_version, spec_json FROM jobs WHERE job_id = ?',
      [prepared.job_id],
    );
    const stored = parseStrictJson(String(row!.spec_json)) as Record<string, unknown>;

    expect(row!.state_version).toBe(1);
    expect(Object.keys(stored).sort()).toEqual([
      'description',
      'input',
      'instructions',
      'name',
      'output',
      'output_field_order',
      'version',
    ]);
    expect(stored).toMatchObject({
      input: {
        loose: false,
        schema: {
          id: { type: ['string', 'integer'] },
          title: { type: 'string' },
        },
      },
      output: {
        loose: false,
        schema: {
          summary: { type: 'string' },
          vote: { type: 'string' },
        },
      },
    });
  });

  it('rejects unknown fields in persisted job structures', async () => {
    const context = await fixture();
    const prepared = await prepare(context);
    const [row] = await sqliteRows(
      prepared.database,
      'SELECT spec_json, settings_json FROM jobs WHERE job_id = ?',
      [prepared.job_id],
    );
    const stored = parseStrictJson(String(row!.spec_json)) as Record<string, unknown>;
    stored.retired = true;
    await sqliteRows(
      prepared.database,
      'UPDATE jobs SET spec_json = ? WHERE job_id = ?',
      [stringifyStrictJson(stored), prepared.job_id],
    );

    await expect(
      context.runtime.status(context.outputDir, prepared.job_id),
    ).rejects.toMatchObject({ code: 'invalid_job' });

    delete stored.retired;
    const settings = parseStrictJson(
      String(row!.settings_json),
    ) as Record<string, unknown>;
    settings.retired = true;
    await sqliteRows(
      prepared.database,
      'UPDATE jobs SET spec_json = ?, settings_json = ? WHERE job_id = ?',
      [stringifyStrictJson(stored), stringifyStrictJson(settings), prepared.job_id],
    );
    await expect(
      context.runtime.status(context.outputDir, prepared.job_id),
    ).rejects.toMatchObject({ code: 'invalid_job' });

    const handleContext = await fixture();
    const handleJob = await prepare(handleContext);
    const [lease] = await nextLeases(handleContext, handleJob.job_id);
    const registryPath = join(
      handleContext.root,
      'registry',
      `${lease!.handle}.json`,
    );
    const registry = await readStrict(registryPath) as Record<string, unknown>;
    registry.retired = true;
    await writeFile(registryPath, stringifyStrictJson(registry), 'utf8');
    await expect(
      handleContext.runtime.getAssignment(lease!.handle),
    ).rejects.toMatchObject({ code: 'invalid_handle' });
  });

  it('rejects duplicate canonical IDs without imposing filename rules', async () => {
    const duplicate = await fixture({
      rows: [
        { id: 1, title: 'Integer' },
        { id: '1', title: 'String' },
      ],
    });
    await expect(prepare(duplicate)).rejects.toMatchObject({
      code: 'duplicate_id',
    });

    const collision = await fixture({
      rows: [
        { id: 'Alpha', title: 'One' },
        { id: 'alpha', title: 'Two' },
      ],
    });
    await expect(prepare(collision)).resolves.toMatchObject({
      counts: { pending: 2 },
    });
  });

  it('rejects lexical float IDs without collapsing them into integer/string IDs', async () => {
    const context = await fixture({
      rawInput:
        '[{"id":1,"title":"Integer"},{"id":"1","title":"String"},{"id":1.0,"title":"Decimal"},{"id":1e0,"title":"Exponent"}]\n',
    });

    const error = await prepare(context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentJobsError);
    expect(error).toMatchObject({ code: 'input_validation_failed' });
    const diagnostics = (error as AgentJobsError).details as Array<{
      code: string;
      row?: number;
      rows?: number[];
    }>;
    expect(
      diagnostics
        .filter(({ code }) => code === 'invalid_id')
        .map(({ row }) => row),
    ).toEqual([2, 3]);
    expect(
      diagnostics
        .filter(({ code }) => code === 'duplicate_id')
        .map(({ rows }) => rows),
    ).toEqual([[0, 1]]);
  });

  it('accepts lexical integer IDs while retaining floats in non-ID fields', async () => {
    const context = await fixture({
      rawInput:
        '[{"id":0,"title":"Zero","score":1.0},{"id":-42,"title":"Negative","score":1e0}]\n',
      inputFields: {
        id: { type: ['string', 'integer'] },
        title: { type: 'string', minLength: 1 },
        score: { type: 'number' },
      },
    });

    const prepared = await prepare(context);
    const leases = await nextLeases(context, prepared.job_id, 2);
    expect(leases.map(({ id }) => id)).toEqual(['0', '-42']);
    const assignments = await Promise.all(
      leases.map(({ handle }) => context.runtime.getAssignment(handle)),
    );
    expect(assignments.map(({ input }) => input)).toEqual([
      { id: 0, title: 'Zero', score: 1 },
      { id: -42, title: 'Negative', score: 1 },
    ]);
  });

  it('preserves unsafe integer IDs in a schema-consistent projected assignment', async () => {
    const context = await fixture({
      rawInput:
        '[{"id":9223372036854775807,"title":"Visible","secret":"hidden"}]\n',
    });
    const prepared = await prepare(context);
    const [lease] = await nextLeases(context, prepared.job_id);

    expect(lease).toMatchObject({ id: '9223372036854775807' });
    expect(Object.keys(lease ?? {})).toEqual(['id', 'handle']);
    const assignment = await context.runtime.getAssignment(lease!.handle);
    expect(assignment.id).toBe('9223372036854775807');
    expect(assignment.input).toEqual({
      id: 9223372036854775807n,
      title: 'Visible',
    });
    expect(assignment.task_spec).toMatchObject({
      name: 'runtime-test',
      instructions: 'Process exactly one row independently.',
      input: {
        loose: false,
        schema: {
          id: { type: ['string', 'integer'] },
          title: { type: 'string' },
        },
      },
      output: {
        loose: false,
        schema: {
          summary: { type: 'string' },
          vote: { type: 'string' },
        },
      },
    });
    await expect(
      context.runtime.getAssignment(lease!.handle),
    ).rejects.toMatchObject({ code: 'handle_consumed' });
  });

  it('passes through and hashes every input field when input is omitted', async () => {
    const context = await fixture({
      rawInput: '[{"id":"one","title":"Visible","secret":"kept"}]\n',
      omitInput: true,
      outputLoose: true,
    });
    const prepared = await prepare(context);
    const [lease] = await nextLeases(context, prepared.job_id);
    const assignment = await context.runtime.getAssignment(lease!.handle);

    expect(assignment.input).toEqual({
      id: 'one',
      title: 'Visible',
      secret: 'kept',
    });
    expect(assignment).not.toHaveProperty('id');
    expect(assignment.task_spec).toMatchObject({
      input: { loose: true, schema: {} },
      output: { loose: true },
    });
    await context.runtime.submitResult(lease!.handle, {
      ...result('one'),
      undeclared: 'kept',
    });

    const collected = await context.runtime.collect(
      context.outputDir,
      prepared.job_id,
      { format: 'json' },
    );
    expect(await readStrict(collected.path as string)).toEqual([{
      id: 'one',
      ...result('one'),
      undeclared: 'kept',
    }]);

    await writeFile(
      context.inputPath,
      '[{"id":"one","title":"Visible","secret":"changed"}]\n',
      'utf8',
    );
    await expect(prepare(context)).resolves.toMatchObject({
      counts: { pending: 1, skipped_valid: 0 },
    });
  });

  it('roundtrips precise decimals through assignment, result, and collection', async () => {
    const context = await fixture({
      rawInput:
        '[{"id":"exact","value":0.100000000000000000001}]\n',
      inputFields: {
        id: { type: 'string' },
        value: { type: 'number' },
      },
      outputFields: {
        value: { type: 'number' },
      },
    });
    const prepared = await prepare(context);
    const [lease] = await nextLeases(context, prepared.job_id);
    const assignment = await context.runtime.getAssignment(lease!.handle);
    expect(isPreciseNumber((assignment.input as Record<string, unknown>).value)).toBe(
      true,
    );
    const output = parseStrictJson('{"value":2.300000000000000000001e500}');
    await context.runtime.submitResult(lease!.handle, output);
    const collected = await context.runtime.collect(
      context.outputDir,
      prepared.job_id,
      { format: 'json' },
    );
    expect(await readFile(collected.path as string, 'utf8')).toContain(
      '2.300000000000000000001e500',
    );
  });

  it('canonicalizes a symlinked OUTPUT_DIR ancestor before persisting state', async () => {
    const context = await fixture();
    const canonicalParent = join(context.root, 'canonical-parent');
    const linkedParent = join(context.root, 'linked-parent');
    await mkdir(canonicalParent);
    await symlink(canonicalParent, linkedParent, 'dir');
    const lexicalOutput = join(linkedParent, 'new', 'output');
    const expectedOutput = join(
      await realpath(canonicalParent),
      'new',
      'output',
    );

    const prepared = await prepare(context, { outputDir: lexicalOutput });
    expect(prepared.output_dir).toBe(expectedOutput);
    expect(prepared.database).toBe(
      join(expectedOutput, '.batch', 'agent-jobs.sqlite'),
    );
    await expect(
      sqliteRows(
        prepared.database,
        'SELECT job_id, output_dir FROM jobs WHERE job_id = ?',
        [prepared.job_id],
      ),
    ).resolves.toEqual([{
      job_id: prepared.job_id,
      output_dir: expectedOutput,
    }]);

    const issued = await context.runtime.next(
      lexicalOutput,
      prepared.job_id,
    );
    const [lease] = issued.assignments as Lease[];
    await complete(context, lease!);
    await expect(
      context.runtime.status(lexicalOutput, prepared.job_id),
    ).resolves.toMatchObject({ counts: { completed: 1 } });
    const [stored] = await sqliteRows(
      prepared.database,
      'SELECT output_json FROM results WHERE record_id = ?',
      ['one'],
    );
    expect(parseStrictJson(String(stored!.output_json))).toEqual(result('one'));
  });

  it('applies embedded migrations and baselines databases without a ledger', async () => {
    const context = await fixture();
    const first = await prepare(context);
    const initialLedger = await sqliteRows(
      first.database,
      'SELECT name, hash FROM __drizzle_migrations',
    );
    expect(initialLedger).toEqual([{
      name: '20260826113404_init',
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }]);

    await sqliteRows(first.database, 'DROP TABLE __drizzle_migrations');
    await expect(
      context.runtime.status(context.outputDir, first.job_id),
    ).resolves.toMatchObject({ job_id: first.job_id });
    await expect(
      sqliteRows(first.database, 'SELECT name FROM __drizzle_migrations'),
    ).resolves.toEqual([{ name: '20260826113404_init' }]);
  });

  it('does not reveal the canonical ID unless the input schema declares its key', async () => {
    const context = await fixture({
      rows: [{ row_key: 'private-id', title: 'Visible' }],
      inputFields: {
        title: { type: 'string' },
      },
    });
    const prepared = await prepare(context, { idColumnKey: 'row_key' });
    const [lease] = await nextLeases(context, prepared.job_id);
    const assignment = await context.runtime.getAssignment(lease!.handle);

    expect(assignment).not.toHaveProperty('id');
    expect(assignment.input).toEqual({ title: 'Visible' });
  });

  it('preserves schema-declared __proto__ as data through assignment and collection', async () => {
    const context = await fixture({
      rawInput:
        '[{"id":"one","__proto__":{"polluted":"input-value"}}]\n',
      inputFields: {
        ...Object.fromEntries([
          ['id', { type: 'string' }],
          ['__proto__', {
            type: 'object',
            properties: { polluted: { type: 'string' } },
          }],
        ]),
      },
      outputFields: {
        ...Object.fromEntries([
          ['__proto__', {
            type: 'object',
            properties: { polluted: { type: 'string' } },
          }],
          ['summary', { type: 'string' }],
        ]),
      },
    });
    const prepared = await prepare(context);
    const [lease] = await nextLeases(context, prepared.job_id);
    const assignment = await context.runtime.getAssignment(lease!.handle);
    const input = assignment.input as Record<string, unknown>;
    expect(Object.hasOwn(input, '__proto__')).toBe(true);
    expect(Reflect.get(input, '__proto__')).toEqual({ polluted: 'input-value' });
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);

    const output = Object.fromEntries([
      ['__proto__', { polluted: 'output-value' }],
      ['summary', 'safe'],
    ]);
    await context.runtime.submitResult(lease!.handle, output);
    const collected = await context.runtime.collect(
      context.outputDir,
      prepared.job_id,
      { format: 'json' },
    );
    const [record] = (await readStrict(collected.path as string)) as Array<
      Record<string, unknown>
    >;
    expect(Object.hasOwn(record!, '__proto__')).toBe(true);
    expect(Reflect.get(record!, '__proto__')).toEqual({ polluted: 'output-value' });
    expect(record!.id).toBe('one');
    expect(Object.getPrototypeOf(record!)).toBe(Object.prototype);
    expect(
      (Object.prototype as { polluted?: unknown }).polluted,
    ).toBeUndefined();
  });

  it('enforces the agent job concurrency cap', async () => {
    const context = await fixture({
      rows: Array.from({ length: 5 }, (_, index) => ({
        id: `row-${index}`,
        title: `${index}`,
      })),
    });
    const prepared = await prepare(context, { maxConcurrency: 2 });
    const first = await nextLeases(context, prepared.job_id, 99);
    expect(first).toHaveLength(2);
    await expect(nextLeases(context, prepared.job_id, 99)).resolves.toEqual(
      [],
    );

    await complete(context, first[0]!);
    await expect(
      nextLeases(context, prepared.job_id, 99),
    ).resolves.toHaveLength(1);
  });

  it('serializes concurrent lease claims without duplicate assignments', async () => {
    const context = await fixture({
      rows: Array.from({ length: 8 }, (_, index) => ({
        id: `row-${index}`,
        title: `${index}`,
      })),
    });
    const prepared = await prepare(context);
    const waves = await Promise.all(
      Array.from({ length: 12 }, () =>
        nextLeases(context, prepared.job_id, 1)),
    );
    const leases = waves.flat();
    expect(leases).toHaveLength(8);
    expect(new Set(leases.map(lease => lease.id)).size).toBe(8);
    expect(new Set(leases.map(lease => lease.handle)).size).toBe(8);
    await expect(
      context.runtime.status(context.outputDir, prepared.job_id),
    ).resolves.toMatchObject({
      counts: { pending: 0, leased: 8, active: 8 },
    });
  });

  it('validates results before committing exactly one database result', async () => {
    const context = await fixture();
    const prepared = await prepare(context);
    const [lease] = await nextLeases(context, prepared.job_id);
    await context.runtime.getAssignment(lease!.handle);

    await expect(
      context.runtime.submitResult(lease!.handle, { summary: 'missing vote' }),
    ).rejects.toMatchObject({ code: 'output_validation_failed' });
    await expect(
      context.runtime.submitResult(lease!.handle, {
        ...result('one'),
        undeclared: true,
      }),
    ).rejects.toMatchObject({ code: 'output_validation_failed' });
    await expect(
      sqliteRows(prepared.database, 'SELECT * FROM results'),
    ).resolves.toEqual([]);

    const submitted = await context.runtime.submitResult(
      lease!.handle,
      result('one', true),
    );
    expect(submitted).toMatchObject({
      id: 'one',
      result_id: expect.any(Number),
      database: prepared.database,
      status: 'completed',
    });
    const [stored] = await sqliteRows(
      prepared.database,
      `SELECT r.output_json, jr.status, jr.result_id
       FROM job_records jr JOIN results r ON r.result_id = jr.result_id
       WHERE jr.job_id = ? AND jr.record_id = ?`,
      [prepared.job_id, 'one'],
    );
    expect(parseStrictJson(String(stored!.output_json))).toEqual(
      result('one', true),
    );
    expect(stored).toMatchObject({
      status: 'completed',
      result_id: submitted.result_id,
    });
    await expect(
      context.runtime.submitResult(lease!.handle, result('replacement')),
    ).rejects.toMatchObject({ code: 'invalid_handle' });
  });

  it('commits the result row and queue transition in one transaction', async () => {
    const context = await fixture();
    const prepared = await prepare(context);
    const [lease] = await nextLeases(context, prepared.job_id);
    await context.runtime.getAssignment(lease!.handle);
    await context.runtime.submitResult(lease!.handle, result('winner'));

    const status = await context.runtime.status(
      context.outputDir,
      prepared.job_id,
    );
    expect(status.counts).toMatchObject({ completed: 1, active: 0 });
    await expect(
      readFile(join(context.root, 'registry', `${lease!.handle}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      sqliteRows(
        prepared.database,
        `SELECT COUNT(*) AS count
         FROM job_records jr JOIN results r ON r.result_id = jr.result_id
         WHERE jr.job_id = ? AND jr.status = 'completed'`,
        [prepared.job_id],
      ),
    ).resolves.toEqual([{ count: 1 }]);
  });

  it('serializes competing result and failure commits without split state', async () => {
    const context = await fixture();
    const prepared = await prepare(context, { maxRetries: 0 });
    const [lease] = await nextLeases(context, prepared.job_id);
    await context.runtime.getAssignment(lease!.handle);
    const outcomes = await Promise.allSettled([
      context.runtime.submitResult(lease!.handle, result('committed')),
      context.runtime.reportFailure(
        lease!.handle,
        'worker_exit',
        'worker exited while submitting',
      ),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(
      1,
    );
    const status = await context.runtime.status(context.outputDir, prepared.job_id);
    const counts = status.counts as Record<string, number>;
    expect(counts.active).toBe(0);
    expect(counts.completed + counts.failed).toBe(1);
    const [row] = await sqliteRows(
      prepared.database,
      `SELECT status, result_id, last_error_json
       FROM job_records WHERE job_id = ? AND record_id = ?`,
      [prepared.job_id, 'one'],
    );
    expect(row!.status).toMatch(/^(completed|failed)$/u);
    expect(
      row!.status === 'completed'
        ? row!.result_id !== null && row!.last_error_json === null
        : row!.result_id === null && row!.last_error_json !== null,
    ).toBe(true);
  });

  it('reports a terminal database failure as incomplete validation', async () => {
    const context = await fixture();
    const prepared = await prepare(context, { maxRetries: 0 });
    const [lease] = await nextLeases(context, prepared.job_id);
    await context.runtime.getAssignment(lease!.handle);
    await expect(
      context.runtime.reportFailure(lease!.handle, 'worker_exit', 'timed out'),
    ).resolves.toMatchObject({ status: 'failed', terminal: true });

    await expect(
      context.runtime.validate(context.outputDir, prepared.job_id),
    ).resolves.toMatchObject({
      valid: false,
      counts: { valid: 0, failed: 1, missing: 0 },
    });
    const status = await context.runtime.status(
      context.outputDir,
      prepared.job_id,
    );
    expect(status).toMatchObject({ counts: { completed: 0, failed: 1 } });
    expect(status.rows).toEqual([expect.objectContaining({
      id: 'one',
      status: 'failed',
      attempts: 1,
      last_error: expect.objectContaining({ code: 'worker_exit' }),
    })]);
  });

  it('issues one fresh retry and persists a structured terminal error', async () => {
    const context = await fixture();
    const prepared = await prepare(context, { maxRetries: 1 });
    const [first] = await nextLeases(context, prepared.job_id);
    await context.runtime.getAssignment(first!.handle);
    await expect(
      context.runtime.reportFailure(first!.handle, 'worker_error', 'first'),
    ).resolves.toMatchObject({ terminal: false, status: 'pending', attempts: 1 });

    const [second] = await nextLeases(context, prepared.job_id);
    expect(second!.handle).not.toBe(first!.handle);
    await context.runtime.getAssignment(second!.handle);
    await expect(
      context.runtime.reportFailure(second!.handle, 'worker_error', 'second'),
    ).resolves.toMatchObject({ terminal: true, status: 'failed', attempts: 2 });
    const status = await context.runtime.status(context.outputDir, prepared.job_id);
    expect(status.rows).toEqual([expect.objectContaining({
      id: 'one',
      status: 'failed',
      attempts: 2,
      last_error: expect.objectContaining({
        id: 'one',
        code: 'worker_error',
        message: 'second',
        attempts: 2,
      }),
    })]);
  });

  it('reuses cache only when ID, input hash, and execution hash all match', async () => {
    const context = await fixture();
    const first = await prepare(context);
    const [lease] = await nextLeases(context, first.job_id);
    await complete(context, lease!, result('cached'));

    const identical = await prepare(context);
    expect(identical.counts).toMatchObject({ skipped_valid: 1, pending: 0 });
    await expect(nextLeases(context, identical.job_id, 10)).resolves.toEqual([]);

    await writeFile(
      context.inputPath,
      `${stringifyStrictJson([{ id: 'one', title: 'Changed' }])}\n`,
      'utf8',
    );
    const changedInput = await prepare(context);
    expect(changedInput.counts).toMatchObject({ skipped_valid: 0, pending: 1 });
    expect(changedInput.source_hash).not.toBe(first.source_hash);

    await writeFile(
      context.inputPath,
      `${stringifyStrictJson([{ id: 'one', title: 'One' }])}\n`,
      'utf8',
    );
    await writeFile(
      context.specPath,
      (await readFile(context.specPath, 'utf8')).replace(
        'Process exactly one row independently.',
        'Process exactly one row independently and carefully.',
      ),
      'utf8',
    );
    const changedTask = await prepare(context);
    expect(changedTask.counts).toMatchObject({ skipped_valid: 0, pending: 1 });
    expect(changedTask.task_hash).not.toBe(first.task_hash);
    expect(changedTask.execution_hash).not.toBe(first.execution_hash);
  });

  it('uses a derived filename as persisted task and cache identity', async () => {
    const context = await fixture({
      omitName: true,
      specFileName: 'summarize-article.md',
    });
    const first = await prepare(context);
    const [firstLease] = await nextLeases(context, first.job_id);
    await complete(context, firstLease!, result('cached'));

    const renamedSpecPath = join(context.root, 'review.task.md');
    await rename(context.specPath, renamedSpecPath);
    const renamed = await prepare(context, { taskSpec: renamedSpecPath });

    expect(renamed.counts).toMatchObject({ skipped_valid: 0, pending: 1 });
    expect(renamed.task_hash).not.toBe(first.task_hash);
    expect(renamed.execution_hash).not.toBe(first.execution_hash);

    const [stored] = await sqliteRows(
      renamed.database,
      'SELECT spec_json FROM jobs WHERE job_id = ?',
      [renamed.job_id],
    );
    expect(parseStrictJson(String(stored!.spec_json))).toMatchObject({
      name: 'review.task',
    });

    const [renamedLease] = await nextLeases(context, renamed.job_id);
    const assignment = await context.runtime.getAssignment(renamedLease!.handle);
    expect(assignment.task_spec).toMatchObject({ name: 'review.task' });
  });

  it('detects stored input and result identity tampering', async () => {
    const inputContext = await fixture();
    const inputPrepared = await prepare(inputContext);
    const [inputLease] = await nextLeases(inputContext, inputPrepared.job_id);
    await sqliteRows(
      inputPrepared.database,
      'UPDATE job_records SET input_json = ? WHERE job_id = ? AND record_id = ?',
      ['{"id":"one","title":"Tampered"}', inputPrepared.job_id, 'one'],
    );
    await expect(
      inputContext.runtime.getAssignment(inputLease!.handle),
    ).rejects.toMatchObject({ code: 'invalid_job' });
    await expect(
      inputContext.runtime.status(inputContext.outputDir, inputPrepared.job_id),
    ).resolves.toMatchObject({ counts: { leased: 1, running: 0 } });

    const resultContext = await fixture();
    const resultPrepared = await prepare(resultContext);
    const [resultLease] = await nextLeases(resultContext, resultPrepared.job_id);
    await complete(resultContext, resultLease!);
    await sqliteRows(
      resultPrepared.database,
      'UPDATE results SET input_hash = ? WHERE record_id = ?',
      ['0'.repeat(64), 'one'],
    );
    await expect(
      resultContext.runtime.validate(
        resultContext.outputDir,
        resultPrepared.job_id,
      ),
    ).resolves.toMatchObject({
      valid: false,
      counts: { valid: 0, invalid: 1 },
      errors: [expect.objectContaining({ code: 'invalid_output' })],
    });
  });

  it('supersedes interrupted assignments and reissues them in the new session', async () => {
    const context = await fixture({
      rows: [
        { id: 'done', title: 'Done' },
        { id: 'running', title: 'Running' },
        { id: 'leased', title: 'Leased' },
      ],
    });
    const first = await prepare(context);
    const [done, running, leased] = await nextLeases(
      context,
      first.job_id,
      3,
    );
    await complete(context, done!);
    await context.runtime.getAssignment(running!.handle);

    const resumed = await prepare(context);
    expect(resumed.job_id).not.toBe(first.job_id);
    expect(resumed).toMatchObject({
      session_status: 'active',
      superseded_job_id: first.job_id,
      reclaimed_assignments: 2,
      counts: { skipped_valid: 1, pending: 2, active: 0 },
    });
    await expect(
      context.runtime.status(context.outputDir, first.job_id),
    ).resolves.toMatchObject({
      session_status: 'superseded',
      superseded_by_job_id: resumed.job_id,
      counts: { completed: 1, pending: 2, active: 0 },
    });
    await expect(
      nextLeases(context, first.job_id, 10),
    ).rejects.toMatchObject({ code: 'session_superseded' });
    await expect(
      context.runtime.validate(context.outputDir, first.job_id),
    ).rejects.toMatchObject({ code: 'session_superseded' });
    await expect(
      context.runtime.submitResult(running!.handle, result('late')),
    ).rejects.toMatchObject({ code: 'invalid_handle' });
    await expect(
      context.runtime.getAssignment(leased!.handle),
    ).rejects.toMatchObject({ code: 'invalid_handle' });
    for (const lease of [running, leased]) {
      await expect(
        readFile(join(context.root, 'registry', `${lease!.handle}.json`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await nextLeases(context, resumed.job_id, 10)).toMatchObject([
      { id: 'running' },
      { id: 'leased' },
    ]);
  });

  it('reuses an atomically committed result in a new session', async () => {
    const context = await fixture();
    const first = await prepare(context);
    const [lease] = await nextLeases(context, first.job_id);
    await complete(context, lease!, result('committed-before-restart'));

    const resumed = await prepare(context);
    expect(resumed).toMatchObject({
      superseded_job_id: first.job_id,
      reclaimed_assignments: 0,
      counts: { skipped_valid: 1, pending: 0, active: 0 },
    });
    await expect(
      nextLeases(context, resumed.job_id, 1),
    ).resolves.toEqual([]);
    await expect(
      context.runtime.submitResult(lease!.handle, result('late')),
    ).rejects.toMatchObject({ code: 'invalid_handle' });
    const [stored] = await sqliteRows(
      resumed.database,
      'SELECT output_json FROM results WHERE record_id = ? ORDER BY result_id DESC',
      ['one'],
    );
    expect(parseStrictJson(String(stored!.output_json))).toEqual(
      result('committed-before-restart'),
    );
  });

  it('collects in input order and stores unsafe IDs without filenames', async () => {
    const ids = ['first', 'unsafe/id', 'last'];
    const context = await fixture({
      rows: ids.map(id => ({ id, title: id })),
    });
    const prepared = await prepare(context);
    const leases = await nextLeases(context, prepared.job_id, 3);
    for (const lease of leases.toReversed()) {
      await complete(context, lease, result(lease.id, true));
    }
    const collected = await context.runtime.collect(
      context.outputDir,
      prepared.job_id,
      { format: 'json' },
    );
    const records = (await readStrict(collected.path as string)) as Array<{
      id: string;
    }>;
    expect(records.map(record => record.id)).toEqual(ids);
    const [stored] = await sqliteRows(
      prepared.database,
      `SELECT record_id, input_hash, output_json
       FROM results WHERE record_id = ?`,
      ['unsafe/id'],
    );
    expect(stored).toMatchObject({
      record_id: 'unsafe/id',
      input_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(parseStrictJson(String(stored!.output_json))).toMatchObject({
      summary: 'summary-unsafe/id',
    });
    await expect(readdir(join(context.outputDir, 'runs'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('writes deterministic JSONL, CSV, and none collections', async () => {
    const context = await fixture({
      rows: [
        { id: 'one', title: 'One' },
        { id: 'two', title: 'Two' },
      ],
    });
    const prepared = await prepare(context);
    for (const lease of await nextLeases(context, prepared.job_id, 2)) {
      await complete(context, lease, result(lease.id, true));
    }

    const jsonl = await context.runtime.collect(
      context.outputDir,
      prepared.job_id,
      { format: 'jsonl' },
    );
    const lines = (await readFile(jsonl.path as string, 'utf8'))
      .trim()
      .split('\n')
      .map(line => parseStrictJson(line) as { id: string });
    expect(lines.map(line => line.id)).toEqual(['one', 'two']);

    const csv = await context.runtime.collect(
      context.outputDir,
      prepared.job_id,
      { format: 'csv' },
    );
    const csvText = await readFile(csv.path as string, 'utf8');
    expect(csvText).toContain('id,summary,vote,details');
    expect(csvText).toContain('"{""score"":3}"');

    await expect(
      context.runtime.collect(context.outputDir, prepared.job_id, {
        format: 'none',
      }),
    ).resolves.toMatchObject({ path: null, count: 2 });
  });

  it('blocks failed collection by default and can continue with successes', async () => {
    const context = await fixture({
      rows: [
        { id: 'ok', title: 'OK' },
        { id: 'bad', title: 'Bad' },
      ],
    });
    const stopped = await prepare(context, { maxRetries: 0 });
    const [ok, bad] = await nextLeases(context, stopped.job_id, 2);
    await complete(context, ok!);
    await context.runtime.reportFailure(
      bad!.handle,
      'worker_failed',
      'no result',
    );
    await expect(
      context.runtime.collect(context.outputDir, stopped.job_id, {
        format: 'json',
      }),
    ).rejects.toMatchObject({ code: 'batch_failed' });

    const continuing = await fixture({
      rows: [
        { id: 'ok', title: 'OK' },
        { id: 'bad', title: 'Bad' },
      ],
    });
    const partial = await prepare(continuing, {
      maxRetries: 0,
      onError: 'continue_successes',
    });
    const [partialOk, partialBad] = await nextLeases(
      continuing,
      partial.job_id,
      2,
    );
    await complete(continuing, partialOk!);
    await continuing.runtime.reportFailure(
      partialBad!.handle,
      'worker_failed',
      'no result',
    );
    const collected = await continuing.runtime.collect(
      continuing.outputDir,
      partial.job_id,
      { format: 'json' },
    );
    expect(collected).toMatchObject({ count: 1, partial: true });
  });

  it('applies model precedence and clears spec effort on model override', async () => {
    const fromSpec = await fixture({
      model: 'small-model',
      reasoningEffort: 'high',
    });
    const specPrepared = await prepare(fromSpec);
    expect(specPrepared.worker).toEqual({
      model: 'small-model',
      reasoning_effort: 'high',
    });

    const override = await fixture({
      model: 'small-model',
      reasoningEffort: 'high',
    });
    const overridden = await prepare(override, { model: 'strong-model' });
    expect(overridden.worker).toEqual({
      model: 'strong-model',
      reasoning_effort: null,
    });
  });

  it('doctor reports the Node 22.13 runtime floor', async () => {
    const context = await fixture();
    const diagnosis = await context.runtime.doctor({ taskSpec: context.specPath });
    const nodeCheck = (diagnosis.checks as Array<Record<string, unknown>>).find(
      check => check.name === 'node',
    );

    expect(nodeCheck).toEqual({
      name: 'node',
      ok: true,
      detail: { version: process.versions.node, required: '>=22.13' },
    });
  });

  it('rejects symlinked managed output paths and registry entries', async () => {
    const context = await fixture();
    await mkdir(context.outputDir);
    const outside = join(context.root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(context.outputDir, '.batch'), 'dir');
    await expect(prepare(context)).rejects.toMatchObject({
      code: 'unsafe_output_path',
      details: { reason: 'symlink' },
    });

    const registryContext = await fixture();
    const prepared = await prepare(registryContext);
    const [lease] = await nextLeases(
      registryContext,
      prepared.job_id,
    );
    const registryPath = join(
      registryContext.root,
      'registry',
      `${lease!.handle}.json`,
    );
    const outsideRegistry = join(registryContext.root, 'outside-registry.json');
    await writeFile(outsideRegistry, await readFile(registryPath));
    await unlink(registryPath);
    await symlink(outsideRegistry, registryPath);
    await expect(
      registryContext.runtime.getAssignment(lease!.handle),
    ).rejects.toMatchObject({
      code: 'unsafe_output_path',
      details: { reason: 'symlink' },
    });
  });
});
