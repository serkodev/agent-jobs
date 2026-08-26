/** SQLite-backed batch queue and capability-based worker protocol. */

import type { Client } from '@libsql/client';
import type { AgentJobsDatabase } from './database.js';
import type { TaskSpec, ValidationDiagnostic } from './spec.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { currentJob, jobRecords, jobs, results } from './database-schema.js';
import { openAgentJobsDatabase, writeTransaction } from './database.js';
import { AgentJobsError } from './errors.js';
import { canonicalizeId, loadRecords } from './input.js';
import { isPreciseNumber } from './numbers.js';
import { loadSpec, validationErrors } from './spec.js';
import {
  atomicWriteJson,
  atomicWriteText,
  parseStrictJson,
  readJson,
  safeUnlink,
  stringifyStrictJson,
} from './storage.js';

export const STATE_VERSION = 2;
const DATABASE_FILENAME = 'agent-jobs.sqlite';
const HANDLE_PREFIX = 'aj_';
const HANDLE_PATTERN = /^aj_[\w-]{32,}$/;
const JOB_ID_PATTERN = /^[0-9a-f]{32}$/;
const ACTIVE_STATUSES = new Set<RecordStatus>(['leased', 'running']);
const TERMINAL_STATUSES = new Set<RecordStatus>([
  'completed',
  'skipped_valid',
  'skipped_invalid',
  'failed',
]);
const COLLECT_FORMATS = new Set<CollectFormat>([
  'none',
  'json',
  'jsonl',
  'csv',
]);
const INSERT_CHUNK_SIZE = 40;

export type PathInput = string | URL;
export type CollectFormat = 'none' | 'json' | 'jsonl' | 'csv';
export type OnError = 'stop' | 'continue_successes';
export type RecordStatus
  = | 'pending'
    | 'leased'
    | 'running'
    | 'completed'
    | 'skipped_valid'
    | 'skipped_invalid'
    | 'failed';

type JsonObject = Record<string, unknown>;
type JsonSchema = Record<string, unknown>;
type JobRow = typeof jobs.$inferSelect;
type JobRecordRow = typeof jobRecords.$inferSelect;
type ResultRow = typeof results.$inferSelect;

export interface AgentJobsRuntimeOptions {
  registryDir?: PathInput;
  projectRoot?: PathInput;
}

export interface PrepareOptions {
  inputData: PathInput;
  taskSpec: PathInput;
  idColumnKey: string;
  outputDir: PathInput;
  recordsPath?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  maxConcurrency?: number | null;
  maxRetries?: number;
  retryInvalid?: boolean;
  onError?: OnError;
  collectFormat?: CollectFormat;
  postProcessModel?: string | null;
  postProcessReasoningEffort?: string | null;
}

interface ResolvedSettings {
  model: string | null;
  reasoning_effort: string | null;
  max_concurrency: number | null;
  max_retries: number;
  retry_invalid: boolean;
  on_error: OnError;
  collect_format: CollectFormat;
  post_process_model: string | null;
  post_process_reasoning_effort: string | null;
}

interface FailureRecord extends JsonObject {
  id: string;
  code: string;
  message: string;
  attempts: number;
  failed_at: string;
}

interface PreparedRecord {
  index: number;
  id: string;
  input: JsonObject;
  inputHash: string;
}

interface SerializedSpec extends JsonObject {
  name: string;
  version: string;
  description: string | null;
  instructions: string;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  output_field_order: string[];
}

interface ParsedJob {
  row: JobRow;
  spec: SerializedSpec;
  settings: ResolvedSettings;
}

interface RegistryEntry extends JsonObject {
  state_version: number;
  database_path: string;
  job_id: string;
  record_index: number;
  handle: string;
}

interface SupersededSession {
  jobId: string;
  reclaimedAssignments: number;
}

interface ValidationReport extends JsonObject {
  job_id: string;
  database: string;
  generated_at: string;
  valid: boolean;
  counts: JsonObject;
  results: JsonObject[];
  errors: JsonObject[];
  on_error: OnError;
}

interface ValidationSnapshot {
  job: ParsedJob;
  report: ValidationReport;
  records: JsonObject[];
}

export interface QueueCounts extends JsonObject {
  total: number;
  pending: number;
  leased: number;
  running: number;
  active: number;
  completed: number;
  skipped: number;
  skipped_valid: number;
  skipped_invalid: number;
  failed: number;
}

interface OpenJobDatabase {
  client: Client;
  close: () => void;
  database: AgentJobsDatabase;
  databasePath: string;
  destination: string;
  jobId: string;
}

/** SQLite is the authority for queue, lease, retry, and result state. */
export class AgentJobsRuntime {
  public readonly registryDir: string;
  public readonly projectRoot: string;

  public constructor(options: AgentJobsRuntimeOptions | PathInput = {}) {
    const structured
      = typeof options === 'string' || options instanceof URL ? {} : options;
    this.projectRoot = absolutePath(
      structured.projectRoot
      ?? process.env.AGENT_JOBS_PROJECT_DIR
      ?? process.env.CLAUDE_PROJECT_DIR
      ?? process.cwd(),
    );
    const explicit
      = typeof options === 'string' || options instanceof URL
        ? options
        : options.registryDir;
    this.registryDir = absolutePath(
      explicit
      ?? process.env.AGENT_JOBS_REGISTRY_DIR
      ?? join(this.projectRoot, '.agent-jobs', 'handles'),
    );
  }

  /** Validate every row before creating any durable job or lease. */
  public async prepare(options: PrepareOptions): Promise<JsonObject> {
    const maxRetries = options.maxRetries ?? 1;
    const retryInvalid = options.retryInvalid ?? false;
    const onError = options.onError ?? 'stop';
    const collectFormat = options.collectFormat ?? 'json';
    const recordsPath = options.recordsPath ?? null;
    const model = options.model ?? null;
    const reasoningEffort = options.reasoningEffort ?? null;
    const maxConcurrency = options.maxConcurrency ?? null;
    const postProcessModel = options.postProcessModel ?? null;
    const postProcessReasoningEffort
      = options.postProcessReasoningEffort ?? null;

    this.validateOptions({
      idColumnKey: options.idColumnKey,
      maxConcurrency,
      maxRetries,
      retryInvalid,
      onError,
      collectFormat,
      optionalStrings: {
        recordsPath,
        model,
        reasoningEffort,
        postProcessModel,
        postProcessReasoningEffort,
      },
    });

    const spec = await loadSpec(options.taskSpec);
    const rows = await loadRecords(options.inputData, recordsPath);
    const preparedRows = this.preflightRows(rows, spec, options.idColumnKey);
    const resolvedModel = model ?? spec.model ?? null;
    const resolvedEffort
      = reasoningEffort ?? (model !== null ? null : (spec.reasoningEffort ?? null));
    const serializedSpec = serializeSpec(spec);
    const settings: ResolvedSettings = {
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
      max_concurrency: maxConcurrency,
      max_retries: maxRetries,
      retry_invalid: retryInvalid,
      on_error: onError,
      collect_format: collectFormat,
      post_process_model: postProcessModel,
      post_process_reasoning_effort: postProcessReasoningEffort,
    };
    const taskHash = hashJson(serializedSpec);
    const executionHash = hashJson({
      task_hash: taskHash,
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
    });
    const sourceHash = hashJson(
      preparedRows.map(record => ({ id: record.id, input_hash: record.inputHash })),
    );
    const destination = await canonicalPath(options.outputDir);
    await ensureOutputLayout(destination, true);
    const databasePath = databasePathFor(destination);
    await ensureDatabaseStorage(databasePath, true);
    const { client, close } = await openAgentJobsDatabase(databasePath, {
      initialize: true,
    });
    const jobId = randomUUID().replaceAll('-', '');
    const staleHandles: string[] = [];

    try {
      const outcome = await writeTransaction(client, async (transaction) => {
        const timestamp = now();
        let superseded: SupersededSession | null = null;
        const [pointer] = await transaction.select().from(currentJob).limit(1);
        if (pointer !== undefined) {
          const [previous] = await transaction
            .select()
            .from(jobs)
            .where(eq(jobs.jobId, pointer.jobId))
            .limit(1);
          if (previous?.sessionStatus === 'active') {
            const active = await transaction
              .select({ leaseToken: jobRecords.leaseToken })
              .from(jobRecords)
              .where(and(
                eq(jobRecords.jobId, previous.jobId),
                inArray(jobRecords.status, ['leased', 'running']),
              ));
            for (const record of active) {
              if (record.leaseToken !== null)
                staleHandles.push(record.leaseToken);
            }
            await transaction
              .update(jobRecords)
              .set({
                status: 'pending',
                leaseToken: null,
                leasedAt: null,
                startedAt: null,
              })
              .where(and(
                eq(jobRecords.jobId, previous.jobId),
                inArray(jobRecords.status, ['leased', 'running']),
              ));
            await transaction
              .update(jobs)
              .set({
                sessionStatus: 'superseded',
                supersededAt: timestamp,
                supersededByJobId: jobId,
                updatedAt: timestamp,
              })
              .where(eq(jobs.jobId, previous.jobId));
            superseded = {
              jobId: previous.jobId,
              reclaimedAssignments: staleHandles.length,
            };
          }
        }

        const cached = await transaction
          .select()
          .from(results)
          .where(eq(results.executionHash, executionHash))
          .orderBy(desc(results.resultId));
        const latestResults = new Map<string, ResultRow>();
        for (const result of cached) {
          const key = cacheKey(result.recordId, result.inputHash);
          if (!latestResults.has(key))
            latestResults.set(key, result);
        }

        const cacheDiagnostics: JsonObject[] = [];
        const persistedRecords = preparedRows.map((record) => {
          const cachedResult = latestResults.get(
            cacheKey(record.id, record.inputHash),
          );
          let status: RecordStatus = 'pending';
          let resultId: number | null = null;
          let cacheErrors: ValidationDiagnostic[] = [];
          if (cachedResult !== undefined) {
            cacheErrors = validateStoredResult(
              cachedResult,
              serializedSpec.output_schema,
            );
            if (cacheErrors.length === 0) {
              status = 'skipped_valid';
              resultId = cachedResult.resultId;
            } else if (!retryInvalid) {
              status = 'skipped_invalid';
              resultId = cachedResult.resultId;
              cacheDiagnostics.push({
                id: record.id,
                result_id: cachedResult.resultId,
                errors: cacheErrors,
              });
            }
          }
          return {
            jobId,
            inputIndex: record.index,
            recordId: record.id,
            inputHash: record.inputHash,
            inputJson: stringifyStrictJson(record.input, { sortKeys: true }),
            status,
            attempts: 0,
            leaseToken: null,
            lastErrorJson: null,
            leasedAt: null,
            startedAt: null,
            completedAt: status === 'skipped_valid' ? timestamp : null,
            cacheValidationErrorsJson: cacheErrors.length === 0
              ? null
              : stringifyStrictJson(cacheErrors, { sortKeys: true }),
            resultId,
          };
        });

        await transaction.insert(jobs).values({
          jobId,
          stateVersion: STATE_VERSION,
          sessionStatus: 'active',
          supersededAt: null,
          supersededByJobId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          inputData: absolutePath(options.inputData),
          taskSpec: absolutePath(spec.path),
          outputDir: destination,
          idColumnKey: options.idColumnKey,
          recordsPath,
          sourceHash,
          taskHash,
          executionHash,
          specJson: stringifyStrictJson(serializedSpec, { sortKeys: true }),
          settingsJson: stringifyStrictJson(settings, { sortKeys: true }),
          cacheDiagnosticsJson: stringifyStrictJson(cacheDiagnostics, {
            sortKeys: true,
          }),
        });
        for (const recordChunk of chunks(persistedRecords, INSERT_CHUNK_SIZE))
          await transaction.insert(jobRecords).values(recordChunk);
        await transaction
          .insert(currentJob)
          .values({ slot: 1, jobId })
          .onConflictDoUpdate({ target: currentJob.slot, set: { jobId } });
        return {
          cacheDiagnostics,
          counts: countsFromStatuses(persistedRecords),
          superseded,
        };
      });

      for (const handle of staleHandles)
        await safeUnlink(this.registryPath(handle));
      return {
        ok: true,
        job_id: jobId,
        session_status: 'active',
        output_dir: destination,
        database: databasePath,
        source_hash: sourceHash,
        task_hash: taskHash,
        execution_hash: executionHash,
        counts: outcome.counts,
        worker: { model: resolvedModel, reasoning_effort: resolvedEffort },
        postprocessor: {
          model: postProcessModel,
          reasoning_effort: postProcessReasoningEffort,
        },
        settings,
        cache_diagnostics: outcome.cacheDiagnostics,
        ...(outcome.superseded === null
          ? {}
          : {
              superseded_job_id: outcome.superseded.jobId,
              reclaimed_assignments: outcome.superseded.reclaimedAssignments,
            }),
      };
    } finally {
      close();
    }
  }

  /** Lease pending rows, returning only canonical IDs and opaque handles. */
  public async next(
    outputDir: PathInput,
    jobId: string | null = null,
    options: { count?: number } = {},
  ): Promise<JsonObject> {
    const requested = options.count ?? 1;
    if (!Number.isInteger(requested) || requested < 1) {
      throw new AgentJobsError('invalid_count', 'count must be a positive integer');
    }
    const opened = await this.openJobDatabase(outputDir, jobId);
    const createdHandles: string[] = [];
    try {
      return await writeTransaction(opened.client, async (transaction) => {
        const job = parseJob(await requireJob(transaction, opened.jobId));
        assertActiveSession(job.row);
        const [activeCount] = await transaction
          .select({ value: sql<number>`count(*)` })
          .from(jobRecords)
          .where(and(
            eq(jobRecords.jobId, opened.jobId),
            inArray(jobRecords.status, ['leased', 'running']),
          ));
        const active = Number(activeCount?.value ?? 0);
        const configuredCap = job.settings.max_concurrency;
        const leaseLimit = configuredCap === null
          ? requested
          : Math.min(requested, Math.max(configuredCap - active, 0));
        const pending = leaseLimit === 0
          ? []
          : await transaction
              .select()
              .from(jobRecords)
              .where(and(
                eq(jobRecords.jobId, opened.jobId),
                eq(jobRecords.status, 'pending'),
              ))
              .orderBy(asc(jobRecords.inputIndex))
              .limit(leaseLimit);
        const assignments: JsonObject[] = [];
        for (const record of pending) {
          const handle = await this.newHandle();
          const registry: RegistryEntry = {
            state_version: STATE_VERSION,
            database_path: opened.databasePath,
            job_id: opened.jobId,
            record_index: record.inputIndex,
            handle,
          };
          await atomicWriteJson(this.registryPath(handle), registry, {
            noClobber: true,
          });
          createdHandles.push(handle);
          const changed = await transaction
            .update(jobRecords)
            .set({
              status: 'leased',
              attempts: record.attempts + 1,
              leaseToken: handle,
              leasedAt: now(),
            })
            .where(and(
              eq(jobRecords.jobId, opened.jobId),
              eq(jobRecords.recordId, record.recordId),
              eq(jobRecords.status, 'pending'),
            ))
            .returning({ recordId: jobRecords.recordId });
          if (changed.length === 0) {
            await safeUnlink(this.registryPath(handle));
            continue;
          }
          assignments.push({ id: record.recordId, handle });
        }
        const statuses = await transaction
          .select({ status: jobRecords.status })
          .from(jobRecords)
          .where(eq(jobRecords.jobId, opened.jobId));
        return {
          ok: true,
          job_id: opened.jobId,
          assignments,
          counts: countsFromStatuses(statuses),
        };
      });
    } catch (error) {
      for (const handle of createdHandles)
        await safeUnlink(this.registryPath(handle));
      throw error;
    } finally {
      opened.close();
    }
  }

  /** Consume a lease once and return one schema-consistent worker payload. */
  public async getAssignment(handle: string): Promise<JsonObject> {
    const opened = await this.openHandleDatabase(handle);
    try {
      return await writeTransaction(opened.client, async (transaction) => {
        const job = parseJob(await requireJob(transaction, opened.registry.job_id));
        assertActiveSession(job.row);
        const record = await requireHandleRecord(
          transaction,
          opened.registry,
          handle,
        );
        if (record.status === 'running') {
          throw new AgentJobsError(
            'handle_consumed',
            'This assignment handle was already retrieved',
          );
        }
        if (record.status !== 'leased') {
          throw new AgentJobsError(
            'invalid_handle',
            'This assignment handle is no longer active',
          );
        }
        await transaction
          .update(jobRecords)
          .set({ status: 'running', startedAt: now() })
          .where(and(
            eq(jobRecords.jobId, record.jobId),
            eq(jobRecords.recordId, record.recordId),
            eq(jobRecords.leaseToken, handle),
          ));
        const payload: JsonObject = {
          input: parseStoredInput(record, job.spec.input_schema),
          task_spec: {
            name: job.spec.name,
            version: job.spec.version,
            description: job.spec.description,
            instructions: job.spec.instructions,
            input_schema: job.spec.input_schema,
            output_schema: job.spec.output_schema,
          },
          attempt: record.attempts,
          model: job.settings.model,
          reasoning_effort: job.settings.reasoning_effort,
        };
        if (
          Object.hasOwn(
            schemaProperties(job.spec.input_schema),
            job.row.idColumnKey,
          )
        ) {
          payload.id = record.recordId;
        }
        return payload;
      });
    } finally {
      opened.close();
    }
  }

  /** Validate and atomically commit a row result in the same database. */
  public async submitResult(handle: string, result: unknown): Promise<JsonObject> {
    if (!isObject(result) || isPreciseNumber(result)) {
      throw new AgentJobsError(
        'output_validation_failed',
        'Worker result must be a JSON object',
        [{ path: '', message: 'result is not an object' }],
      );
    }
    const jsonProblem = strictJsonProblem(result);
    if (jsonProblem !== null) {
      throw new AgentJobsError(
        'output_validation_failed',
        'Worker result must contain only strict JSON values',
        [{ path: '', message: jsonProblem, validator: 'json' }],
      );
    }
    const opened = await this.openHandleDatabase(handle);
    try {
      const outcome = await writeTransaction(
        opened.client,
        async (transaction) => {
          const job = parseJob(await requireJob(transaction, opened.registry.job_id));
          assertActiveSession(job.row);
          const record = await requireHandleRecord(
            transaction,
            opened.registry,
            handle,
          );
          if (record.status !== 'running') {
            const code = TERMINAL_STATUSES.has(record.status as RecordStatus)
              ? 'handle_consumed'
              : 'invalid_handle';
            throw new AgentJobsError(
              code,
              'This assignment handle cannot submit a result',
            );
          }
          const errors = validationErrors(result, job.spec.output_schema);
          if (errors.length > 0) {
            throw new AgentJobsError(
              'output_validation_failed',
              'Worker result does not satisfy output_schema',
              errors,
            );
          }
          const outputJson = stringifyStrictJson(result, { sortKeys: true });
          const [stored] = await transaction
            .insert(results)
            .values({
              recordId: record.recordId,
              inputHash: record.inputHash,
              executionHash: job.row.executionHash,
              outputJson,
              outputHash: hashText(outputJson),
              createdAt: now(),
            })
            .returning({ resultId: results.resultId });
          if (stored === undefined)
            throw new AgentJobsError('storage_error', 'Result insert returned no ID');
          const changed = await transaction
            .update(jobRecords)
            .set({
              status: 'completed',
              resultId: stored.resultId,
              completedAt: now(),
              leaseToken: null,
              cacheValidationErrorsJson: null,
            })
            .where(and(
              eq(jobRecords.jobId, record.jobId),
              eq(jobRecords.recordId, record.recordId),
              eq(jobRecords.status, 'running'),
              eq(jobRecords.leaseToken, handle),
            ))
            .returning({ recordId: jobRecords.recordId });
          if (changed.length === 0) {
            throw new AgentJobsError(
              'handle_consumed',
              'This assignment handle cannot submit a result',
            );
          }
          return { id: record.recordId, resultId: stored.resultId };
        },
      );
      await safeUnlink(this.registryPath(handle));
      return {
        ok: true,
        id: outcome.id,
        result_id: outcome.resultId,
        database: opened.databasePath,
        status: 'completed',
      };
    } finally {
      opened.close();
    }
  }

  /** Record a failed attempt, requeueing until the retry budget is exhausted. */
  public async reportFailure(
    handle: string,
    code: string,
    message: string,
  ): Promise<JsonObject> {
    if (typeof code !== 'string' || code.trim().length === 0) {
      throw new AgentJobsError('invalid_failure', 'Failure code must be non-empty');
    }
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new AgentJobsError(
        'invalid_failure',
        'Failure message must be non-empty',
      );
    }
    const opened = await this.openHandleDatabase(handle);
    try {
      const outcome = await writeTransaction(
        opened.client,
        async (transaction) => {
          const job = parseJob(await requireJob(transaction, opened.registry.job_id));
          assertActiveSession(job.row);
          const record = await requireHandleRecord(
            transaction,
            opened.registry,
            handle,
          );
          if (!ACTIVE_STATUSES.has(record.status as RecordStatus)) {
            throw new AgentJobsError(
              'handle_consumed',
              'This assignment handle is no longer active',
            );
          }
          const failure: FailureRecord = {
            id: record.recordId,
            code: code.trim(),
            message: message.trim(),
            attempts: record.attempts,
            failed_at: now(),
          };
          const terminal = record.attempts > job.settings.max_retries;
          const status: RecordStatus = terminal ? 'failed' : 'pending';
          await transaction
            .update(jobRecords)
            .set({
              status,
              leaseToken: null,
              lastErrorJson: stringifyStrictJson(failure, { sortKeys: true }),
              leasedAt: null,
              startedAt: null,
            })
            .where(and(
              eq(jobRecords.jobId, record.jobId),
              eq(jobRecords.recordId, record.recordId),
              eq(jobRecords.leaseToken, handle),
            ));
          return {
            id: record.recordId,
            terminal,
            status,
            attempts: record.attempts,
          };
        },
      );
      await safeUnlink(this.registryPath(handle));
      return { ok: true, ...outcome };
    } finally {
      opened.close();
    }
  }

  /** Return queue state without exposing row input or output values. */
  public async status(
    outputDir: PathInput,
    jobId: string | null = null,
  ): Promise<JsonObject> {
    const opened = await this.openJobDatabase(outputDir, jobId);
    try {
      return await opened.database.transaction(async (transaction) => {
        const job = parseJob(await requireJob(transaction, opened.jobId));
        const records = await transaction
          .select()
          .from(jobRecords)
          .where(eq(jobRecords.jobId, opened.jobId))
          .orderBy(asc(jobRecords.inputIndex));
        return {
          ok: true,
          job_id: job.row.jobId,
          session_status: job.row.sessionStatus,
          ...(job.row.supersededByJobId === null
            ? {}
            : { superseded_by_job_id: job.row.supersededByJobId }),
          output_dir: job.row.outputDir,
          database: opened.databasePath,
          counts: countsFromStatuses(records),
          rows: records.map(record => ({
            id: record.recordId,
            input_hash: record.inputHash,
            status: record.status,
            attempts: record.attempts,
            ...(record.lastErrorJson === null
              ? {}
              : {
                  last_error: parseJsonObject(
                    record.lastErrorJson,
                    'last error',
                  ),
                }),
          })),
        };
      });
    } finally {
      opened.close();
    }
  }

  /** Validate every expected result from one consistent database snapshot. */
  public async validate(
    outputDir: PathInput,
    jobId: string | null = null,
  ): Promise<JsonObject> {
    const opened = await this.openJobDatabase(outputDir, jobId);
    try {
      const snapshot = await buildValidationSnapshot(
        opened.database,
        opened.jobId,
        opened.databasePath,
      );
      await atomicWriteJson(
        join(opened.destination, 'report.json'),
        snapshot.report,
      );
      return { ok: true, ...snapshot.report };
    } finally {
      opened.close();
    }
  }

  /** Collect valid results in input order into one deterministic artifact. */
  public async collect(
    outputDir: PathInput,
    jobId: string | null = null,
    options: { format?: CollectFormat | null } = {},
  ): Promise<JsonObject> {
    const opened = await this.openJobDatabase(outputDir, jobId);
    try {
      const snapshot = await buildValidationSnapshot(
        opened.database,
        opened.jobId,
        opened.databasePath,
      );
      const selectedFormat
        = options.format ?? snapshot.job.settings.collect_format;
      if (!COLLECT_FORMATS.has(selectedFormat)) {
        throw new AgentJobsError(
          'invalid_collect_format',
          'format must be none, json, jsonl, or csv',
        );
      }
      await atomicWriteJson(
        join(opened.destination, 'report.json'),
        snapshot.report,
      );
      if (!snapshot.report.valid && snapshot.job.settings.on_error === 'stop') {
        throw new AgentJobsError(
          'batch_failed',
          'Collection is blocked because final validation failed',
          snapshot.report.errors,
        );
      }
      if (selectedFormat === 'none') {
        return {
          ok: true,
          job_id: opened.jobId,
          format: 'none',
          path: null,
          count: snapshot.records.length,
          partial: !snapshot.report.valid,
        };
      }
      const collectionPath = join(
        opened.destination,
        `collected.${selectedFormat}`,
      );
      await writeCollection(
        collectionPath,
        selectedFormat,
        snapshot.records,
        snapshot.job.row.idColumnKey,
        snapshot.job.spec.output_schema,
        snapshot.job.spec.output_field_order,
      );
      return {
        ok: true,
        job_id: opened.jobId,
        format: selectedFormat,
        path: collectionPath,
        count: snapshot.records.length,
        partial: !snapshot.report.valid,
      };
    } finally {
      opened.close();
    }
  }

  /** Run local configuration and storage checks without invoking a model. */
  public async doctor(
    options: {
      outputDir?: PathInput | null;
      taskSpec?: PathInput | null;
    } = {},
  ): Promise<JsonObject> {
    const checks: JsonObject[] = [];
    const nodeVersion = process.versions.node;
    const [majorText = '0', minorText = '0'] = nodeVersion.split('.');
    const major = Number.parseInt(majorText, 10);
    const minor = Number.parseInt(minorText, 10);
    checks.push({
      name: 'node',
      ok: major > 20 || (major === 20 && minor >= 6),
      detail: { version: nodeVersion, required: '>=20.6' },
    });

    const installation: Record<string, unknown> = {};
    let installed = false;
    for (const [host, candidates] of Object.entries(
      installationCandidates(this.projectRoot, homedir()),
    )) {
      const details: JsonObject[] = [];
      let hostInstalled = false;
      for (const candidate of candidates) {
        const missing: string[] = [];
        for (const path of candidate.paths) {
          try {
            await ensureRealFile(path);
          } catch {
            missing.push(path);
          }
        }
        const ok = missing.length === 0;
        hostInstalled ||= ok;
        details.push({ scope: candidate.scope, ok, missing });
      }
      installed ||= hostInstalled;
      installation[host] = { ok: hostInstalled, candidates: details };
    }
    checks.push({
      name: 'installation',
      ok: installed,
      detail: {
        code: installed ? 'installed' : 'init_required',
        hosts: installation,
        hint: installed
          ? null
          : 'Run agent-jobs init --yes (or use the published/local npx package).',
      },
    });

    try {
      await mkdir(this.registryDir, { recursive: true });
      const probe = join(
        this.registryDir,
        `.doctor-${randomUUID().replaceAll('-', '')}`,
      );
      await atomicWriteText(probe, 'ok\n', { noClobber: true });
      await safeUnlink(probe);
      checks.push({ name: 'handle_registry', ok: true, detail: this.registryDir });
    } catch (error) {
      checks.push({
        name: 'handle_registry',
        ok: false,
        detail: errorMessage(error),
      });
    }

    if (options.taskSpec !== undefined && options.taskSpec !== null) {
      try {
        const parsed = await loadSpec(options.taskSpec);
        checks.push({ name: 'task_spec', ok: true, detail: parsed.name });
      } catch (error) {
        checks.push({
          name: 'task_spec',
          ok: false,
          detail: diagnostic(error),
        });
      }
    }
    if (options.outputDir !== undefined && options.outputDir !== null) {
      let opened: OpenJobDatabase | undefined;
      try {
        opened = await this.openJobDatabase(options.outputDir, null);
        checks.push({
          name: 'output_dir',
          ok: true,
          detail: { database: opened.databasePath, job_id: opened.jobId },
        });
      } catch (error) {
        checks.push({
          name: 'output_dir',
          ok: false,
          detail: diagnostic(error),
        });
      } finally {
        opened?.close();
      }
    }

    return {
      ok: checks.every(check => check.ok === true),
      node: nodeVersion,
      node_executable: process.execPath,
      project_root: this.projectRoot,
      registry_dir: this.registryDir,
      checks,
    };
  }

  private preflightRows(
    rows: JsonObject[],
    spec: TaskSpec,
    idColumnKey: string,
  ): PreparedRecord[] {
    const prepared: PreparedRecord[] = [];
    const diagnostics: JsonObject[] = [];
    const duplicateDiagnostics: JsonObject[] = [];
    const identifiers = new Map<string, number>();
    const properties = schemaProperties(spec.inputSchema);

    for (const [index, source] of rows.entries()) {
      let identifier: string | null = null;
      if (!Object.hasOwn(source, idColumnKey)) {
        diagnostics.push({
          row: index,
          code: 'missing_id',
          path: `/${idColumnKey}`,
        });
      } else {
        try {
          identifier = canonicalizeId(source[idColumnKey]);
        } catch (error) {
          if (!(error instanceof AgentJobsError))
            throw error;
          diagnostics.push({
            row: index,
            code: error.code,
            path: `/${idColumnKey}`,
            message: error.message,
          });
        }
      }
      if (identifier !== null) {
        const firstIndex = identifiers.get(identifier);
        if (firstIndex !== undefined) {
          duplicateDiagnostics.push({
            id: identifier,
            rows: [firstIndex, index],
            code: 'duplicate_id',
          });
        } else {
          identifiers.set(identifier, index);
        }
      }

      const projected = Object.create(null) as JsonObject;
      for (const key of Object.keys(properties)) {
        if (Object.hasOwn(source, key))
          projected[key] = source[key];
      }
      const jsonProblem = strictJsonProblem(projected);
      if (jsonProblem !== null) {
        diagnostics.push({
          row: index,
          id: identifier,
          code: 'input_not_json',
          path: '',
          message: jsonProblem,
        });
      }
      for (const error of validationErrors(projected, spec.inputSchema)) {
        diagnostics.push({
          row: index,
          id: identifier,
          code: 'input_schema',
          ...error,
        });
      }
      const id = identifier ?? `invalid-row-${index}`;
      prepared.push({
        index,
        id,
        input: projected,
        inputHash: hashJson({ id, input: projected }),
      });
    }

    diagnostics.push(...duplicateDiagnostics);
    if (diagnostics.length > 0) {
      const code
        = duplicateDiagnostics.length > 0
          && diagnostics.length === duplicateDiagnostics.length
          ? 'duplicate_id'
          : 'input_validation_failed';
      throw new AgentJobsError(
        code,
        'Input preflight failed; no workers were scheduled',
        diagnostics,
      );
    }
    return prepared;
  }

  private validateOptions(options: {
    idColumnKey: unknown;
    maxConcurrency: unknown;
    maxRetries: unknown;
    retryInvalid: unknown;
    onError: unknown;
    collectFormat: unknown;
    optionalStrings: Record<string, unknown>;
  }): void {
    if (
      typeof options.idColumnKey !== 'string'
      || options.idColumnKey.trim().length === 0
    ) {
      throw new AgentJobsError(
        'invalid_id_column_key',
        'id_column_key must be non-empty',
      );
    }
    if (
      options.maxConcurrency !== null
      && (typeof options.maxConcurrency !== 'number'
        || !Number.isInteger(options.maxConcurrency)
        || options.maxConcurrency < 1)
    ) {
      throw new AgentJobsError(
        'invalid_max_concurrency',
        'max_concurrency must be positive',
      );
    }
    if (
      typeof options.maxRetries !== 'number'
      || !Number.isInteger(options.maxRetries)
      || options.maxRetries < 0
    ) {
      throw new AgentJobsError(
        'invalid_max_retries',
        'max_retries must be non-negative',
      );
    }
    if (typeof options.retryInvalid !== 'boolean') {
      throw new AgentJobsError(
        'invalid_retry_invalid',
        'retry_invalid must be a boolean',
      );
    }
    if (options.onError !== 'stop' && options.onError !== 'continue_successes') {
      throw new AgentJobsError(
        'invalid_on_error',
        'on_error must be stop or continue_successes',
      );
    }
    if (
      typeof options.collectFormat !== 'string'
      || !COLLECT_FORMATS.has(options.collectFormat as CollectFormat)
    ) {
      throw new AgentJobsError(
        'invalid_collect_format',
        'collect_format must be none, json, jsonl, or csv',
      );
    }
    for (const [name, value] of Object.entries(options.optionalStrings)) {
      if (
        value !== null
        && (typeof value !== 'string'
          || (name !== 'recordsPath' && value.trim().length === 0))
      ) {
        throw new AgentJobsError(
          'invalid_option',
          `${camelToSnake(name)} must be a non-empty string`,
        );
      }
    }
  }

  private async openJobDatabase(
    outputDir: PathInput,
    jobId: string | null,
  ): Promise<OpenJobDatabase> {
    const destination = await canonicalPath(outputDir);
    await ensureOutputLayout(destination, false);
    const databasePath = databasePathFor(destination);
    await ensureDatabaseStorage(databasePath, false);
    const { client, close, db } = await openAgentJobsDatabase(databasePath);
    try {
      const selected = await resolveJobId(db, jobId);
      return {
        client,
        close,
        database: db,
        databasePath,
        destination,
        jobId: selected,
      };
    } catch (error) {
      close();
      throw error;
    }
  }

  private async openHandleDatabase(handle: string): Promise<{
    client: Client;
    close: () => void;
    database: AgentJobsDatabase;
    databasePath: string;
    registry: RegistryEntry;
  }> {
    const registry = await this.readRegistry(handle);
    const databasePath = await registryDatabasePath(registry);
    const { client, close, db } = await openAgentJobsDatabase(databasePath);
    return { client, close, database: db, databasePath, registry };
  }

  private async newHandle(): Promise<string> {
    await mkdir(this.registryDir, { recursive: true });
    for (;;) {
      const handle = `${HANDLE_PREFIX}${randomBytes(32).toString('base64url')}`;
      if (!(await pathExists(this.registryPath(handle))))
        return handle;
    }
  }

  private registryPath(handle: string): string {
    if (typeof handle !== 'string' || !HANDLE_PATTERN.test(handle)) {
      throw new AgentJobsError('invalid_handle', 'Assignment handle is invalid');
    }
    return join(this.registryDir, `${handle}.json`);
  }

  private async readRegistry(handle: string): Promise<RegistryEntry> {
    const path = this.registryPath(handle);
    if (!(await pathExists(path))) {
      throw new AgentJobsError(
        'invalid_handle',
        'Assignment handle is unknown or expired',
      );
    }
    await ensureRealFile(path);
    const value = await readJson(path);
    if (
      !isObject(value)
      || value.state_version !== STATE_VERSION
      || value.handle !== handle
      || typeof value.database_path !== 'string'
      || typeof value.job_id !== 'string'
      || !Number.isInteger(value.record_index)
    ) {
      throw new AgentJobsError(
        'invalid_handle',
        'Assignment registry entry is invalid',
      );
    }
    return value as unknown as RegistryEntry;
  }
}

async function buildValidationSnapshot(
  database: AgentJobsDatabase,
  jobId: string,
  databasePath: string,
): Promise<ValidationSnapshot> {
  return await database.transaction(async (transaction) => {
    const job = parseJob(await requireJob(transaction, jobId));
    assertActiveSession(job.row);
    const rows = await transaction
      .select({ record: jobRecords, result: results })
      .from(jobRecords)
      .leftJoin(results, eq(jobRecords.resultId, results.resultId))
      .where(eq(jobRecords.jobId, jobId))
      .orderBy(asc(jobRecords.inputIndex));
    const validResults: JsonObject[] = [];
    const collected: JsonObject[] = [];
    const errors: JsonObject[] = [];
    let invalid = 0;
    let missing = 0;
    let failed = 0;

    for (const { record, result } of rows) {
      const inputErrors = storedInputErrors(record, job.spec.input_schema);
      if (inputErrors.length > 0) {
        invalid += 1;
        errors.push({
          id: record.recordId,
          code: 'invalid_stored_input',
          errors: inputErrors,
        });
        continue;
      }
      if (result === null) {
        if (record.status === 'failed') {
          failed += 1;
          errors.push({
            id: record.recordId,
            code: 'worker_failed',
            error: record.lastErrorJson === null
              ? null
              : parseJsonObject(record.lastErrorJson, 'last error'),
          });
        } else {
          missing += 1;
          errors.push({
            id: record.recordId,
            code: 'missing_output',
            status: record.status,
          });
        }
        continue;
      }
      const rowErrors = [
        ...storedResultIdentityErrors(result, record, job.row),
        ...validateStoredResult(result, job.spec.output_schema),
      ];
      if (rowErrors.length > 0) {
        invalid += 1;
        errors.push({
          id: record.recordId,
          code: 'invalid_output',
          result_id: result.resultId,
          errors: rowErrors,
        });
        continue;
      }
      const output = parseJsonObject(result.outputJson, 'stored result');
      validResults.push({ id: record.recordId, result_id: result.resultId });
      const merged = Object.create(null) as JsonObject;
      merged[job.row.idColumnKey] = record.recordId;
      for (const [key, value] of Object.entries(output)) {
        if (key !== job.row.idColumnKey)
          merged[key] = value;
      }
      collected.push(merged);
    }
    return {
      job,
      report: {
        job_id: job.row.jobId,
        database: databasePath,
        generated_at: now(),
        valid: errors.length === 0,
        counts: {
          total: rows.length,
          valid: validResults.length,
          invalid,
          missing,
          failed,
        },
        results: validResults,
        errors,
        on_error: job.settings.on_error,
      },
      records: collected,
    };
  });
}

function validateStoredResult(
  result: ResultRow,
  schema: JsonSchema,
): ValidationDiagnostic[] {
  if (hashText(result.outputJson) !== result.outputHash) {
    return [{
      path: '',
      message: 'stored result hash does not match its JSON payload',
      validator: 'integrity',
    }];
  }
  try {
    return validationErrors(parseStrictJson(result.outputJson), schema);
  } catch (error) {
    return [{ path: '', message: errorMessage(error), validator: 'json' }];
  }
}

async function resolveJobId(
  database: AgentJobsDatabase,
  requested: string | null,
): Promise<string> {
  let selected = requested;
  if (selected === null) {
    const [pointer] = await database.select().from(currentJob).limit(1);
    if (pointer === undefined) {
      throw new AgentJobsError('job_not_found', 'No current agent job exists');
    }
    selected = pointer.jobId;
  }
  if (!JOB_ID_PATTERN.test(selected))
    throw new AgentJobsError('invalid_job_id', 'Invalid job ID');
  const [job] = await database
    .select({ jobId: jobs.jobId })
    .from(jobs)
    .where(eq(jobs.jobId, selected))
    .limit(1);
  if (job === undefined) {
    throw new AgentJobsError(
      'job_not_found',
      `Agent job does not exist: ${selected}`,
    );
  }
  return selected;
}

type SelectDatabase = Pick<AgentJobsDatabase, 'select'>;

async function requireJob(
  database: SelectDatabase,
  jobId: string,
): Promise<JobRow> {
  const [job] = await database
    .select()
    .from(jobs)
    .where(eq(jobs.jobId, jobId))
    .limit(1);
  if (job === undefined) {
    throw new AgentJobsError('job_not_found', `Agent job does not exist: ${jobId}`);
  }
  return job;
}

async function requireHandleRecord(
  database: SelectDatabase,
  registry: RegistryEntry,
  handle: string,
): Promise<JobRecordRow> {
  const [record] = await database
    .select()
    .from(jobRecords)
    .where(and(
      eq(jobRecords.jobId, registry.job_id),
      eq(jobRecords.inputIndex, registry.record_index),
      eq(jobRecords.leaseToken, handle),
    ))
    .limit(1);
  if (record === undefined) {
    throw new AgentJobsError('invalid_handle', 'Handle is no longer current');
  }
  return record;
}

function parseJob(row: JobRow): ParsedJob {
  if (row.stateVersion !== STATE_VERSION) {
    throw new AgentJobsError(
      'invalid_job',
      'Agent job state is missing or incompatible',
    );
  }
  if (row.sessionStatus !== 'active' && row.sessionStatus !== 'superseded') {
    throw new AgentJobsError('invalid_job', 'Agent job session status is invalid');
  }
  return {
    row,
    spec: parseJsonObject(row.specJson, 'job spec') as SerializedSpec,
    settings: parseJsonObject(
      row.settingsJson,
      'job settings',
    ) as unknown as ResolvedSettings,
  };
}

function assertActiveSession(job: JobRow): void {
  if (job.sessionStatus === 'active')
    return;
  throw new AgentJobsError(
    'session_superseded',
    'This agent job session was superseded by a newer run',
    {
      job_id: job.jobId,
      superseded_by_job_id: job.supersededByJobId,
    },
  );
}

function countsFromStatuses(
  records: ReadonlyArray<{ status: string }>,
): QueueCounts {
  const statuses = new Map<string, number>();
  for (const record of records)
    statuses.set(record.status, (statuses.get(record.status) ?? 0) + 1);
  const leased = statuses.get('leased') ?? 0;
  const running = statuses.get('running') ?? 0;
  const skippedValid = statuses.get('skipped_valid') ?? 0;
  const skippedInvalid = statuses.get('skipped_invalid') ?? 0;
  return {
    total: records.length,
    pending: statuses.get('pending') ?? 0,
    leased,
    running,
    active: leased + running,
    completed: statuses.get('completed') ?? 0,
    skipped: skippedValid + skippedInvalid,
    skipped_valid: skippedValid,
    skipped_invalid: skippedInvalid,
    failed: statuses.get('failed') ?? 0,
  };
}

function serializeSpec(spec: TaskSpec): SerializedSpec {
  return {
    name: spec.name,
    version: spec.version,
    description: spec.description ?? null,
    instructions: spec.instructions,
    input_schema: spec.inputSchema,
    output_schema: spec.outputSchema,
    output_field_order: Object.keys(schemaProperties(spec.outputSchema)),
  };
}

function schemaProperties(schema: JsonSchema): JsonObject {
  return isObject(schema.properties) ? schema.properties : {};
}

function parseJsonObject(text: string, label: string): JsonObject {
  try {
    const value = parseStrictJson(text);
    if (!isObject(value) || isPreciseNumber(value))
      throw new TypeError(`${label} is not an object`);
    return value;
  } catch (error) {
    throw new AgentJobsError(
      'invalid_job',
      `Could not parse ${label}: ${errorMessage(error)}`,
    );
  }
}

function parseStoredInput(
  record: JobRecordRow,
  schema: JsonSchema,
): JsonObject {
  const input = parseJsonObject(record.inputJson, 'record input');
  const errors = storedInputErrors(record, schema, input);
  if (errors.length > 0) {
    throw new AgentJobsError(
      'invalid_job',
      'Stored input failed integrity or schema validation',
      errors,
    );
  }
  return input;
}

function storedInputErrors(
  record: JobRecordRow,
  schema: JsonSchema,
  parsed?: JsonObject,
): ValidationDiagnostic[] {
  try {
    const input = parsed ?? parseJsonObject(record.inputJson, 'record input');
    const errors = validationErrors(input, schema);
    if (hashJson({ id: record.recordId, input }) !== record.inputHash) {
      errors.unshift({
        path: '',
        message: 'stored input hash does not match its ID and JSON payload',
        validator: 'integrity',
      });
    }
    return errors;
  } catch (error) {
    return [{ path: '', message: errorMessage(error), validator: 'json' }];
  }
}

function storedResultIdentityErrors(
  result: ResultRow,
  record: JobRecordRow,
  job: JobRow,
): ValidationDiagnostic[] {
  return result.recordId === record.recordId
    && result.inputHash === record.inputHash
    && result.executionHash === job.executionHash
    ? []
    : [{
        path: '',
        message: 'stored result identity does not match its job record',
        validator: 'integrity',
      }];
}

function hashJson(value: unknown): string {
  return hashText(stringifyStrictJson(value, { sortKeys: true }));
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cacheKey(recordId: string, inputHash: string): string {
  return `${recordId.length}:${recordId}${inputHash}`;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}

async function registryDatabasePath(registry: RegistryEntry): Promise<string> {
  const path = registry.database_path;
  if (
    !isAbsolute(path)
    || !JOB_ID_PATTERN.test(registry.job_id)
    || basename(path) !== DATABASE_FILENAME
    || basename(dirname(path)) !== '.batch'
  ) {
    throw new AgentJobsError('invalid_handle', 'Handle database path is invalid');
  }
  const destination = dirname(dirname(path));
  if (path !== databasePathFor(destination)) {
    throw new AgentJobsError('invalid_handle', 'Handle database path is invalid');
  }
  await ensureOutputLayout(destination, false);
  await ensureDatabaseStorage(path, false);
  return path;
}

function databasePathFor(destination: string): string {
  return join(destination, '.batch', DATABASE_FILENAME);
}

async function writeCollection(
  path: string,
  format: Exclude<CollectFormat, 'none'>,
  records: JsonObject[],
  idKey: string,
  outputSchema: JsonSchema,
  outputFieldOrder?: string[],
): Promise<void> {
  if (format === 'json') {
    await atomicWriteText(path, `${stringifyStrictJson(records, { pretty: true })}\n`);
    return;
  }
  if (format === 'jsonl') {
    await atomicWriteText(
      path,
      records.map(record => `${stringifyStrictJson(record)}\n`).join(''),
    );
    return;
  }
  const fields = [idKey];
  const declaredFields
    = outputFieldOrder ?? Object.keys(schemaProperties(outputSchema));
  for (const key of declaredFields) {
    if (!fields.includes(key))
      fields.push(key);
  }
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!fields.includes(key))
        fields.push(key);
    }
  }
  const lines = [fields.map(csvCell).join(',')];
  for (const record of records) {
    lines.push(fields.map(field => csvCell(
      Object.hasOwn(record, field) ? csvValue(record[field]) : '',
    )).join(','));
  }
  await atomicWriteText(path, `${lines.join('\r\n')}\r\n`);
}

function csvValue(value: unknown): string | number | bigint {
  if (value === null || value === undefined)
    return '';
  if (typeof value === 'boolean')
    return value ? 'true' : 'false';
  if (Array.isArray(value) || isObject(value))
    return stringifyStrictJson(value);
  if (
    typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'bigint'
  ) {
    return value;
  }
  return String(value);
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function ensureOutputLayout(
  destination: string,
  create: boolean,
): Promise<void> {
  await ensureRealDirectory(destination, create, create);
  await ensureRealDirectory(join(destination, '.batch'), create, false);
}

async function ensureDatabaseStorage(path: string, create: boolean): Promise<void> {
  if (!create && !(await managedFileExists(path))) {
    throw new AgentJobsError(
      'job_not_found',
      `Agent job database does not exist: ${path}`,
      { database: path },
    );
  }
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    if (await pathExists(candidate))
      await ensureRealFile(candidate);
  }
}

async function ensureRealDirectory(
  path: string,
  create: boolean,
  parents: boolean,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (!isMissingFileError(error))
      throw unsafeInspectionError('directory', path, error);
    if (!create) {
      throw new AgentJobsError(
        'unsafe_output_path',
        `Managed output directory is missing: ${path}`,
        { path, reason: 'missing' },
      );
    }
    try {
      await mkdir(path, { recursive: parents });
    } catch (mkdirError) {
      if (!isAlreadyExistsError(mkdirError)) {
        throw new AgentJobsError(
          'unsafe_output_path',
          `Could not create managed output directory: ${path}`,
          { path, reason: errorMessage(mkdirError) },
        );
      }
    }
    try {
      metadata = await lstat(path);
    } catch (inspectError) {
      throw unsafeInspectionError('directory', path, inspectError);
    }
  }
  let reason: string | null = null;
  if (metadata.isSymbolicLink())
    reason = 'symlink';
  else if (!metadata.isDirectory())
    reason = 'not_directory';
  if (reason !== null) {
    throw new AgentJobsError(
      'unsafe_output_path',
      `Managed output path must be a real directory: ${path}`,
      { path, reason },
    );
  }
}

async function ensureRealFile(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new AgentJobsError(
        'storage_not_found',
        `Managed output file does not exist: ${path}`,
        { path },
      );
    }
    throw unsafeInspectionError('file', path, error);
  }
  let reason: string | null = null;
  if (metadata.isSymbolicLink())
    reason = 'symlink';
  else if (!metadata.isFile())
    reason = 'not_regular_file';
  if (reason !== null) {
    throw new AgentJobsError(
      'unsafe_output_path',
      `Managed output path must be a real file: ${path}`,
      { path, reason },
    );
  }
}

async function managedFileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissingFileError(error))
      return false;
    throw unsafeInspectionError('file', path, error);
  }
  await ensureRealFile(path);
  return true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error))
      return false;
    throw unsafeInspectionError('file', path, error);
  }
}

function unsafeInspectionError(
  kind: 'directory' | 'file',
  path: string,
  error: unknown,
): AgentJobsError {
  return new AgentJobsError(
    'unsafe_output_path',
    `Could not inspect managed output ${kind}: ${path}`,
    { path, reason: errorMessage(error) },
  );
}

function strictJsonProblem(value: unknown): string | null {
  const seen = new Set<object>();
  const visit = (item: unknown, path: string): string | null => {
    if (isPreciseNumber(item))
      return null;
    if (
      item === null
      || typeof item === 'string'
      || typeof item === 'boolean'
      || typeof item === 'bigint'
    ) {
      return null;
    }
    if (typeof item === 'number') {
      return Number.isFinite(item) ? null : `${path} contains a non-finite number`;
    }
    if (typeof item !== 'object')
      return `${path} contains a non-JSON ${typeof item} value`;
    if (seen.has(item))
      return `${path} contains a cyclic value`;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const [index, child] of item.entries()) {
        const problem = visit(child, `${path}/${index}`);
        if (problem !== null)
          return problem;
      }
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null)
        return `${path} contains a non-plain object`;
      if (Object.getOwnPropertySymbols(item).length > 0)
        return `${path} contains a symbol-keyed property`;
      for (const [key, child] of Object.entries(item)) {
        const problem = visit(child, `${path}/${escapePointer(key)}`);
        if (problem !== null)
          return problem;
      }
    }
    seen.delete(item);
    return null;
  };
  const problem = visit(value, '');
  if (problem !== null)
    return problem;
  try {
    stringifyStrictJson(value);
  } catch (error) {
    return errorMessage(error);
  }
  return null;
}

function absolutePath(input: PathInput): string {
  if (input instanceof URL)
    return resolve(fileURLToPath(input));
  const expanded = input === '~'
    ? homedir()
    : input.startsWith('~/')
      ? join(homedir(), input.slice(2))
      : input;
  return resolve(expanded);
}

/** Resolve existing path components without losing a symlinked parent. */
async function canonicalPath(input: PathInput): Promise<string> {
  const candidate = unresolvedAbsolutePath(input);
  let cursor = candidate;
  const unresolved: string[] = [];
  for (;;) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...unresolved.toReversed());
    } catch (error) {
      if (!isMissingFileError(error) && !hasNodeCode(error, 'ENOTDIR')) {
        throw new AgentJobsError(
          'unsafe_output_path',
          `Could not resolve managed output path: ${cursor}`,
          { path: cursor, reason: errorMessage(error) },
        );
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new AgentJobsError(
          'unsafe_output_path',
          `Could not resolve managed output path: ${candidate}`,
          { path: candidate, reason: errorMessage(error) },
        );
      }
      unresolved.push(basename(cursor));
      cursor = parent;
    }
  }
}

function unresolvedAbsolutePath(input: PathInput): string {
  if (input instanceof URL)
    return fileURLToPath(input);
  const expanded = input === '~'
    ? homedir()
    : input.startsWith('~/')
      ? `${homedir()}${sep}${input.slice(2)}`
      : input;
  return isAbsolute(expanded) ? expanded : `${process.cwd()}${sep}${expanded}`;
}

function installationCandidates(projectRoot: string, userHome: string): Record<
  string,
  Array<{ scope: string; paths: string[] }>
> {
  return {
    codex: [
      {
        scope: 'project',
        paths: [
          join(projectRoot, 'AGENTS.md'),
          join(projectRoot, '.codex', 'config.toml'),
          join(projectRoot, '.codex', 'agents', 'agent_job_worker.toml'),
          join(projectRoot, '.codex', 'agents', 'agent_job_postprocessor.toml'),
          join(projectRoot, '.agents', 'skills', 'agent-jobs', 'SKILL.md'),
          join(
            projectRoot,
            '.agents',
            'skills',
            'agent-jobs',
            'scripts',
            'agent-jobs.mjs',
          ),
        ],
      },
      {
        scope: 'global',
        paths: [
          join(userHome, '.codex', 'AGENTS.md'),
          join(userHome, '.codex', 'config.toml'),
          join(userHome, '.codex', 'agents', 'agent_job_worker.toml'),
          join(userHome, '.codex', 'agents', 'agent_job_postprocessor.toml'),
          join(userHome, '.agents', 'skills', 'agent-jobs', 'SKILL.md'),
          join(
            userHome,
            '.agents',
            'skills',
            'agent-jobs',
            'scripts',
            'agent-jobs.mjs',
          ),
        ],
      },
      {
        scope: 'development',
        paths: [
          join(projectRoot, 'AGENTS.md'),
          join(projectRoot, '.codex', 'config.toml'),
          join(projectRoot, '.codex', 'agents', 'agent_job_worker.toml'),
          join(projectRoot, '.codex', 'agents', 'agent_job_postprocessor.toml'),
          join(projectRoot, '.agents', 'skills', 'agent-jobs', 'SKILL.md'),
          join(projectRoot, 'dist', 'agent-jobs.mjs'),
        ],
      },
    ],
    claude: [
      {
        scope: 'project',
        paths: [
          join(projectRoot, 'CLAUDE.md'),
          join(projectRoot, '.mcp.json'),
          join(projectRoot, '.claude', 'settings.local.json'),
          join(projectRoot, '.claude', 'agents', 'agent_job_worker.md'),
          join(projectRoot, '.claude', 'agents', 'agent_job_postprocessor.md'),
          join(projectRoot, '.claude', 'skills', 'agent-jobs', 'SKILL.md'),
          join(
            projectRoot,
            '.claude',
            'skills',
            'agent-jobs',
            'scripts',
            'agent-jobs.mjs',
          ),
        ],
      },
      {
        scope: 'global',
        paths: [
          join(userHome, '.claude', 'CLAUDE.md'),
          join(userHome, '.claude.json'),
          join(userHome, '.claude', 'settings.json'),
          join(userHome, '.claude', 'agents', 'agent_job_worker.md'),
          join(userHome, '.claude', 'agents', 'agent_job_postprocessor.md'),
          join(userHome, '.claude', 'skills', 'agent-jobs', 'SKILL.md'),
          join(
            userHome,
            '.claude',
            'skills',
            'agent-jobs',
            'scripts',
            'agent-jobs.mjs',
          ),
        ],
      },
    ],
  };
}

function diagnostic(error: unknown): unknown {
  return error instanceof AgentJobsError ? error.asDict() : errorMessage(error);
}

function now(): string {
  return new Date().toISOString();
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/gu, character => `_${character.toLowerCase()}`);
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function isAlreadyExistsError(error: unknown): boolean {
  return hasNodeCode(error, 'EEXIST');
}

function hasNodeCode(error: unknown, code: string): boolean {
  return isNodeError(error) && error.code === code;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
