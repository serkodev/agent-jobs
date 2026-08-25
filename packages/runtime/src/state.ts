/** Persistent batch queue and capability-based worker protocol. */

import type { TaskSpec, ValidationDiagnostic } from './spec.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from 'node:path';
import process from 'node:process';

import { fileURLToPath } from 'node:url';
import { AgentJobsError } from './errors.js';
import {
  canonicalizeId,
  loadRecords,
  safeIdFilename,
} from './input.js';
import {
  loadSpec,

  validationErrors,
} from './spec.js';
import {
  atomicMove,
  atomicWriteJson,
  atomicWriteText,
  readJson,
  safeUnlink,
  stringifyStrictJson,
  withLock,
} from './storage.js';

export const STATE_VERSION = 1;
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

interface AgentJobItemRecord extends JsonObject {
  index: number;
  id: string;
  safe_id: string;
  input: JsonObject;
  status: RecordStatus;
  attempts: number;
  handle: string | null;
  last_error: FailureRecord | null;
  leased_at?: string;
  started_at?: string;
  completed_at?: string;
  archived_invalid_path?: string;
  cache_validation_errors?: ValidationDiagnostic[];
}

interface SerializedSpec extends JsonObject {
  name: string;
  version: string;
  description: string | null;
  instructions: string;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  /** Declaration order survives canonical state JSON key sorting for CSV. */
  output_field_order: string[];
}

interface AgentJobState extends JsonObject {
  state_version: number;
  job_id: string;
  created_at: string;
  updated_at: string;
  input_data: string;
  task_spec: string;
  output_dir: string;
  id_column_key: string;
  records_path: string | null;
  spec: SerializedSpec;
  settings: ResolvedSettings;
  records: AgentJobItemRecord[];
  cache_diagnostics: JsonObject[];
}

interface RegistryEntry extends JsonObject {
  state_version: number;
  state_path: string;
  job_id: string;
  record_index: number;
  handle: string;
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

/**
 * Coordinate durable row assignments while keeping complete row data out of the
 * parent conversation. All mutating operations are serialized per agent job.
 */
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
    const configured
      = explicit
        ?? process.env.AGENT_JOBS_REGISTRY_DIR
        ?? join(this.projectRoot, '.agent-jobs', 'handles');
    this.registryDir = absolutePath(configured);
  }

  /** Validate every row before creating any durable agent job or lease. */
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
    // A prompt-level model override intentionally clears a spec-level effort.
    const resolvedEffort
      = reasoningEffort ?? (model !== null ? null : (spec.reasoningEffort ?? null));
    const jobId = randomUUID().replaceAll('-', '');
    const destination = await canonicalPath(options.outputDir);
    const runsDir = join(destination, 'runs');
    const jobsDir = join(destination, '.batch', 'jobs');

    await ensureOutputLayout(destination, true);
    const archiveRoot = join(
      destination,
      'history',
      'invalid',
      `${archiveStamp()}-${jobId}`,
    );
    const cacheDiagnostics: JsonObject[] = [];

    for (const row of preparedRows) {
      await ensureOutputLayout(destination, false);
      const runPath = join(runsDir, `${row.safe_id}.json`);
      if (!(await managedFileExists(runPath))) {
        row.status = 'pending';
        continue;
      }
      const errors = await this.validateRunFile(runPath, spec.outputSchema);
      if (errors.length > 0 && retryInvalid) {
        const archivePath = join(archiveRoot, basename(runPath));
        await ensureArchiveDirectory(archiveRoot);
        await atomicMove(runPath, archivePath);
        row.status = 'pending';
        row.archived_invalid_path = archivePath;
        continue;
      }
      row.status = errors.length > 0 ? 'skipped_invalid' : 'skipped_valid';
      row.cache_validation_errors = errors;
      if (errors.length > 0) {
        cacheDiagnostics.push({ id: row.id, path: runPath, errors });
      }
    }

    const timestamp = now();
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
    const state: AgentJobState = {
      state_version: STATE_VERSION,
      job_id: jobId,
      created_at: timestamp,
      updated_at: timestamp,
      input_data: absolutePath(options.inputData),
      task_spec: absolutePath(spec.path),
      output_dir: destination,
      id_column_key: options.idColumnKey,
      records_path: recordsPath,
      spec: serializeSpec(spec),
      settings,
      records: preparedRows,
      cache_diagnostics: cacheDiagnostics,
    };
    const statePath = join(jobsDir, `${jobId}.json`);
    await ensureOutputLayout(destination, false);
    await atomicWriteJson(statePath, state, { noClobber: true });
    await ensureOutputLayout(destination, false);
    await atomicWriteJson(join(destination, '.batch', 'current.json'), {
      job_id: jobId,
      state_path: statePath,
    });

    return {
      ok: true,
      job_id: jobId,
      output_dir: destination,
      counts: counts(state),
      worker: {
        model: resolvedModel,
        reasoning_effort: resolvedEffort,
      },
      postprocessor: {
        model: postProcessModel,
        reasoning_effort: postProcessReasoningEffort,
      },
      settings,
      cache_diagnostics: cacheDiagnostics,
    };
  }

  /** Lease pending rows, returning only canonical IDs and opaque handles. */
  public async next(
    outputDir: PathInput,
    jobId: string | null = null,
    options: { count?: number } = {},
  ): Promise<JsonObject> {
    const requested = options.count ?? 1;
    if (!Number.isInteger(requested) || requested < 1) {
      throw new AgentJobsError(
        'invalid_count',
        'count must be a positive integer',
      );
    }
    const statePath = await this.statePath(outputDir, jobId);

    return await withLock(lockPath(statePath), async () => {
      const state = await this.readState(statePath);
      await ensureStateOutputLayout(state);
      await this.reconcileCommittedRuns(state);
      const active = state.records.filter(record =>
        ACTIVE_STATUSES.has(record.status),
      ).length;
      const configuredCap = state.settings.max_concurrency;
      const leaseLimit
        = configuredCap === null
          ? requested
          : Math.min(requested, Math.max(configuredCap - active, 0));
      const assignments: JsonObject[] = [];

      for (const record of state.records) {
        if (assignments.length >= leaseLimit)
          break;
        if (record.status !== 'pending')
          continue;

        const handle = await this.newHandle();
        record.status = 'leased';
        record.attempts += 1;
        record.handle = handle;
        record.leased_at = now();
        const registry: RegistryEntry = {
          state_version: STATE_VERSION,
          state_path: statePath,
          job_id: state.job_id,
          record_index: record.index,
          handle,
        };
        await atomicWriteJson(this.registryPath(handle), registry, {
          noClobber: true,
        });
        assignments.push({ id: record.id, handle });
      }

      await this.saveState(statePath, state);
      return {
        ok: true,
        job_id: state.job_id,
        assignments,
        counts: counts(state),
      };
    });
  }

  /** Consume a lease once and return one exact, schema-consistent worker payload. */
  public async getAssignment(handle: string): Promise<JsonObject> {
    const registry = await this.readRegistry(handle);
    const statePath = await this.registryStatePath(registry);

    return await withLock(lockPath(statePath), async () => {
      const state = await this.readState(statePath);
      await ensureStateOutputLayout(state);
      const record = recordForRegistry(state, registry, handle);
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
      record.status = 'running';
      record.started_at = now();
      await this.saveState(statePath, state);

      const properties = schemaProperties(state.spec.input_schema);
      const payload: JsonObject = {
        input: record.input,
        task_spec: {
          name: state.spec.name,
          version: state.spec.version,
          description: state.spec.description,
          instructions: state.spec.instructions,
          input_schema: state.spec.input_schema,
          output_schema: state.spec.output_schema,
        },
        attempt: record.attempts,
        model: state.settings.model,
        reasoning_effort: state.settings.reasoning_effort,
      };
      if (Object.hasOwn(properties, state.id_column_key)) {
        payload.id = record.id;
      }
      return payload;
    });
  }

  /** Validate and atomically publish a pure row result without overwriting. */
  public async submitResult(handle: string, result: unknown): Promise<JsonObject> {
    if (!isObject(result)) {
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

    const registry = await this.readRegistry(handle);
    const statePath = await this.registryStatePath(registry);
    const outcome = await withLock(lockPath(statePath), async () => {
      const state = await this.readState(statePath);
      await ensureStateOutputLayout(state);
      const record = recordForRegistry(state, registry, handle);
      if (record.status !== 'running') {
        const code = TERMINAL_STATUSES.has(record.status)
          ? 'handle_consumed'
          : 'invalid_handle';
        throw new AgentJobsError(
          code,
          'This assignment handle cannot submit a result',
        );
      }
      const errors = validationErrors(result, state.spec.output_schema);
      if (errors.length > 0) {
        throw new AgentJobsError(
          'output_validation_failed',
          'Worker result does not satisfy output_schema',
          errors,
        );
      }

      const runPath = runPathFor(state, record);
      try {
        await ensureStateOutputLayout(state);
        await atomicWriteJson(runPath, result, { noClobber: true });
      } catch (error) {
        if (error instanceof AgentJobsError && error.code === 'target_exists') {
          throw new AgentJobsError(
            'output_exists',
            'A result already exists for this row; refusing to overwrite it',
            error.details,
          );
        }
        throw error;
      }
      record.status = 'completed';
      record.completed_at = now();
      record.handle = null;
      await this.saveState(statePath, state);
      return { state, record, runPath };
    });

    await ensureStateOutputLayout(outcome.state);
    await safeUnlink(this.registryPath(handle));
    await safeUnlink(errorPathFor(outcome.state, outcome.record));
    return {
      ok: true,
      id: outcome.record.id,
      path: outcome.runPath,
      status: 'completed',
    };
  }

  /** Record a failed attempt, requeueing until the retry budget is exhausted. */
  public async reportFailure(
    handle: string,
    code: string,
    message: string,
  ): Promise<JsonObject> {
    if (typeof code !== 'string' || code.trim().length === 0) {
      throw new AgentJobsError(
        'invalid_failure',
        'Failure code must be non-empty',
      );
    }
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new AgentJobsError(
        'invalid_failure',
        'Failure message must be non-empty',
      );
    }
    const registry = await this.readRegistry(handle);
    const statePath = await this.registryStatePath(registry);
    const outcome = await withLock(lockPath(statePath), async () => {
      const state = await this.readState(statePath);
      await ensureStateOutputLayout(state);
      const record = recordForRegistry(state, registry, handle);
      if (!ACTIVE_STATUSES.has(record.status)) {
        throw new AgentJobsError(
          'handle_consumed',
          'This assignment handle is no longer active',
        );
      }
      const committedPath = runPathFor(state, record);
      if (await managedFileExists(committedPath)) {
        const committedErrors = await this.validateRunFile(
          committedPath,
          state.spec.output_schema,
        );
        if (committedErrors.length === 0) {
          const staleHandle = record.handle;
          record.status = 'completed';
          record.completed_at ??= now();
          record.cache_validation_errors = [];
          record.handle = null;
          await this.saveState(statePath, state);
          if (staleHandle !== null) {
            await safeUnlink(this.registryPath(staleHandle));
          }
          await safeUnlink(errorPathFor(state, record));
          return { record, terminal: true, reconciled: true };
        }
      }
      const failure: FailureRecord = {
        id: record.id,
        code: code.trim(),
        message: message.trim(),
        attempts: record.attempts,
        failed_at: now(),
      };
      record.last_error = failure;
      record.handle = null;
      const terminal = record.attempts > state.settings.max_retries;
      if (terminal) {
        record.status = 'failed';
        await ensureStateOutputLayout(state);
        await atomicWriteJson(errorPathFor(state, record), failure);
      } else {
        record.status = 'pending';
      }
      await this.saveState(statePath, state);
      return { record, terminal, reconciled: false };
    });

    await safeUnlink(this.registryPath(handle));
    return {
      ok: true,
      id: outcome.record.id,
      terminal: outcome.terminal,
      status: outcome.record.status,
      attempts: outcome.record.attempts,
      ...(outcome.reconciled ? { reconciled: true } : {}),
    };
  }

  /** Return queue state without exposing row input or output values. */
  public async status(
    outputDir: PathInput,
    jobId: string | null = null,
  ): Promise<JsonObject> {
    const statePath = await this.statePath(outputDir, jobId);
    return await withLock(lockPath(statePath), async () => {
      const state = await this.readState(statePath);
      await ensureStateOutputLayout(state);
      if (await this.reconcileCommittedRuns(state)) {
        await this.saveState(statePath, state);
      }
      return {
        ok: true,
        job_id: state.job_id,
        output_dir: state.output_dir,
        counts: counts(state),
        rows: state.records.map(record => ({
          id: record.id,
          status: record.status,
          attempts: record.attempts,
          ...(record.last_error === null
            ? {}
            : { last_error: record.last_error }),
        })),
      };
    });
  }

  /** Validate every expected run and persist the final report. */
  public async validate(
    outputDir: PathInput,
    jobId: string | null = null,
  ): Promise<JsonObject> {
    const statePath = await this.statePath(outputDir, jobId);
    return await withLock(lockPath(statePath), async () => {
      const state = await this.readState(statePath);
      await ensureStateOutputLayout(state);
      if (await this.reconcileCommittedRuns(state)) {
        await this.saveState(statePath, state);
      }
      const report = await this.buildValidationReport(state);
      await ensureStateOutputLayout(state);
      await atomicWriteJson(join(state.output_dir, 'report.json'), report);
      return { ok: true, ...report };
    });
  }

  /** Collect valid results in input order into one deterministic artifact. */
  public async collect(
    outputDir: PathInput,
    jobId: string | null = null,
    options: { format?: CollectFormat | null } = {},
  ): Promise<JsonObject> {
    const statePath = await this.statePath(outputDir, jobId);
    return await withLock(lockPath(statePath), async () => {
      const state = await this.readState(statePath);
      await ensureStateOutputLayout(state);
      const selectedFormat
        = options.format ?? state.settings.collect_format;
      if (!COLLECT_FORMATS.has(selectedFormat)) {
        throw new AgentJobsError(
          'invalid_collect_format',
          'format must be none, json, jsonl, or csv',
        );
      }
      if (await this.reconcileCommittedRuns(state)) {
        await this.saveState(statePath, state);
      }
      const report = await this.buildValidationReport(state);
      await ensureStateOutputLayout(state);
      await atomicWriteJson(join(state.output_dir, 'report.json'), report);
      if (!report.valid && state.settings.on_error === 'stop') {
        throw new AgentJobsError(
          'batch_failed',
          'Collection is blocked because final validation failed',
          report.errors,
        );
      }
      const records = await this.validCollectedRecords(state);
      if (selectedFormat === 'none') {
        return {
          ok: true,
          job_id: state.job_id,
          format: 'none',
          path: null,
          count: records.length,
        };
      }
      const collectionPath = join(
        state.output_dir,
        `collected.${selectedFormat}`,
      );
      await ensureStateOutputLayout(state);
      await writeCollection(
        collectionPath,
        selectedFormat,
        records,
        state.id_column_key,
        state.spec.output_schema,
        state.spec.output_field_order,
      );
      return {
        ok: true,
        job_id: state.job_id,
        format: selectedFormat,
        path: collectionPath,
        count: records.length,
        partial: !report.valid,
      };
    });
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
    const nodeSupported = major > 20 || (major === 20 && minor >= 6);
    checks.push({
      name: 'node',
      ok: nodeSupported,
      detail: { version: nodeVersion, required: '>=20.6' },
    });

    const userHome = homedir();
    const hostFiles = {
      codex: [
        {
          scope: 'project',
          paths: [
            join(this.projectRoot, 'AGENTS.md'),
            join(this.projectRoot, '.codex', 'config.toml'),
            join(this.projectRoot, '.codex', 'agents', 'agent_job_worker.toml'),
            join(
              this.projectRoot,
              '.codex',
              'agents',
              'agent_job_postprocessor.toml',
            ),
            join(
              this.projectRoot,
              '.agents',
              'skills',
              'agent-jobs',
              'SKILL.md',
            ),
            join(
              this.projectRoot,
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
            join(this.projectRoot, 'AGENTS.md'),
            join(this.projectRoot, '.codex', 'config.toml'),
            join(this.projectRoot, '.codex', 'agents', 'agent_job_worker.toml'),
            join(
              this.projectRoot,
              '.codex',
              'agents',
              'agent_job_postprocessor.toml',
            ),
            join(
              this.projectRoot,
              '.agents',
              'skills',
              'agent-jobs',
              'SKILL.md',
            ),
            join(this.projectRoot, 'dist', 'agent-jobs.mjs'),
          ],
        },
      ],
      claude: [
        {
          scope: 'project',
          paths: [
            join(this.projectRoot, 'CLAUDE.md'),
            join(this.projectRoot, '.mcp.json'),
            join(this.projectRoot, '.claude', 'settings.local.json'),
            join(this.projectRoot, '.claude', 'agents', 'agent_job_worker.md'),
            join(
              this.projectRoot,
              '.claude',
              'agents',
              'agent_job_postprocessor.md',
            ),
            join(
              this.projectRoot,
              '.claude',
              'skills',
              'agent-jobs',
              'SKILL.md',
            ),
            join(
              this.projectRoot,
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
    const installation: Record<string, unknown> = {};
    let installed = false;
    for (const [host, candidates] of Object.entries(hostFiles)) {
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
      checks.push({
        name: 'handle_registry',
        ok: true,
        detail: this.registryDir,
      });
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
          detail:
            error instanceof AgentJobsError
              ? error.asDict()
              : errorMessage(error),
        });
      }
    }
    if (options.outputDir !== undefined && options.outputDir !== null) {
      try {
        const current = await this.statePath(options.outputDir, null);
        checks.push({ name: 'output_dir', ok: true, detail: current });
      } catch (error) {
        checks.push({
          name: 'output_dir',
          ok: false,
          detail:
            error instanceof AgentJobsError
              ? error.asDict()
              : errorMessage(error),
        });
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
  ): AgentJobItemRecord[] {
    const prepared: AgentJobItemRecord[] = [];
    const diagnostics: JsonObject[] = [];
    const duplicateDiagnostics: JsonObject[] = [];
    const identifiers = new Map<string, number>();
    const filenames = new Map<string, string>();
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

      let safeId: string;
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
        safeId = safeIdFilename(identifier);
        const filenameKey = safeId.toLowerCase();
        const existing = filenames.get(filenameKey);
        if (existing !== undefined && existing !== identifier) {
          diagnostics.push({
            row: index,
            code: 'id_filename_collision',
            id: identifier,
          });
        }
        filenames.set(filenameKey, identifier);
      } else {
        safeId = `invalid-row-${index}`;
      }

      // Dynamic JSON field names such as `__proto__` must remain data, not invoke
      // Object.prototype's legacy setter.
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
      prepared.push({
        index,
        // This placeholder never survives a successful preflight.
        id: identifier ?? `invalid-row-${index}`,
        safe_id: safeId,
        input: projected,
        status: 'pending',
        attempts: 0,
        handle: null,
        last_error: null,
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
    if (
      options.onError !== 'stop'
      && options.onError !== 'continue_successes'
    ) {
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

  private async statePath(
    outputDir: PathInput,
    jobId: string | null,
  ): Promise<string> {
    const destination = await canonicalPath(outputDir);
    await ensureOutputLayout(destination, false);
    let selected: unknown = jobId;
    if (selected === null) {
      const pointerPath = join(destination, '.batch', 'current.json');
      if (!(await managedFileExists(pointerPath))) {
        throw new AgentJobsError(
          'job_not_found',
          `No current agent job exists in ${destination}`,
        );
      }
      const pointer = await readJson(pointerPath);
      selected = isObject(pointer) ? pointer.job_id : null;
    }
    if (typeof selected !== 'string' || !JOB_ID_PATTERN.test(selected)) {
      throw new AgentJobsError(
        'invalid_job_id',
        'Invalid job ID',
      );
    }
    const path = join(
      destination,
      '.batch',
      'jobs',
      `${selected}.json`,
    );
    if (!(await managedFileExists(path))) {
      throw new AgentJobsError(
        'job_not_found',
        `Agent job does not exist: ${selected}`,
        { path },
      );
    }
    return path;
  }

  private async readState(path: string): Promise<AgentJobState> {
    const value = await readJson(path);
    if (!isObject(value) || value.state_version !== STATE_VERSION) {
      throw new AgentJobsError(
        'invalid_job',
        'Agent job state is missing or incompatible',
      );
    }
    if (!Array.isArray(value.records)) {
      throw new AgentJobsError(
        'invalid_job',
        'Agent job items are invalid',
      );
    }
    return value as unknown as AgentJobState;
  }

  private async saveState(path: string, state: AgentJobState): Promise<void> {
    state.updated_at = now();
    await atomicWriteJson(path, state);
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
      throw new AgentJobsError(
        'invalid_handle',
        'Assignment handle is invalid',
      );
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
      || value.handle !== handle
      || typeof value.state_path !== 'string'
      || !Number.isInteger(value.record_index)
    ) {
      throw new AgentJobsError(
        'invalid_handle',
        'Assignment registry entry is invalid',
      );
    }
    return value as unknown as RegistryEntry;
  }

  private async registryStatePath(registry: RegistryEntry): Promise<string> {
    const statePath = registry.state_path;
    const jobId = registry.job_id;
    if (
      !isAbsolute(statePath)
      || typeof jobId !== 'string'
      || !JOB_ID_PATTERN.test(jobId)
      || basename(statePath) !== `${jobId}.json`
      || basename(dirname(statePath)) !== 'jobs'
      || basename(dirname(dirname(statePath))) !== '.batch'
    ) {
      throw new AgentJobsError(
        'invalid_handle',
        'Handle state path is invalid',
      );
    }
    const destination = dirname(dirname(dirname(statePath)));
    const expected = join(
      destination,
      '.batch',
      'jobs',
      `${jobId}.json`,
    );
    if (statePath !== expected) {
      throw new AgentJobsError(
        'invalid_handle',
        'Handle state path is invalid',
      );
    }
    await ensureOutputLayout(destination, false);
    await ensureRealFile(statePath);
    return statePath;
  }

  private async validateRunFile(
    path: string,
    schema: JsonSchema,
  ): Promise<ValidationDiagnostic[]> {
    await ensureRealFile(path);
    try {
      const value = await readJson(path);
      return validationErrors(value, schema);
    } catch (error) {
      if (error instanceof AgentJobsError) {
        return [{ path: '', message: error.message, validator: 'json' }];
      }
      throw error;
    }
  }

  private async reconcileCommittedRuns(
    state: AgentJobState,
  ): Promise<boolean> {
    let changed = false;
    for (const record of state.records) {
      if (
        !ACTIVE_STATUSES.has(record.status)
        && record.status !== 'pending'
        && record.status !== 'failed'
      ) {
        continue;
      }
      const path = runPathFor(state, record);
      if (!(await managedFileExists(path)))
        continue;
      const errors = await this.validateRunFile(
        path,
        state.spec.output_schema,
      );
      const wasFailed = record.status === 'failed';
      // An invalid file cannot erase a durable terminal worker failure. A valid
      // result, however, is the authoritative row outcome even when it arrived
      // after failure bookkeeping.
      if (wasFailed && errors.length > 0)
        continue;
      record.status = errors.length > 0 ? 'skipped_invalid' : 'completed';
      record.cache_validation_errors = errors;
      if (errors.length === 0) {
        record.completed_at ??= now();
        if (wasFailed)
          record.last_error = null;
        await safeUnlink(errorPathFor(state, record));
      }
      const handle = record.handle;
      record.handle = null;
      if (handle !== null)
        await safeUnlink(this.registryPath(handle));
      changed = true;
    }
    return changed;
  }

  private async buildValidationReport(
    state: AgentJobState,
  ): Promise<ValidationReport> {
    const results: JsonObject[] = [];
    const errors: JsonObject[] = [];
    let invalid = 0;
    let missing = 0;
    let failed = 0;
    for (const record of state.records) {
      const path = runPathFor(state, record);
      if (!(await managedFileExists(path))) {
        if (record.status === 'failed') {
          failed += 1;
          errors.push({
            id: record.id,
            code: 'worker_failed',
            path: errorPathFor(state, record),
            error: record.last_error,
          });
        } else {
          missing += 1;
          errors.push({
            id: record.id,
            code: 'missing_output',
            status: record.status,
            path,
          });
        }
        continue;
      }
      const rowErrors = await this.validateRunFile(
        path,
        state.spec.output_schema,
      );
      if (rowErrors.length > 0) {
        invalid += 1;
        errors.push({
          id: record.id,
          code: 'invalid_output',
          path,
          errors: rowErrors,
        });
      } else {
        results.push({ id: record.id, path });
      }
    }
    return {
      job_id: state.job_id,
      generated_at: now(),
      valid: errors.length === 0,
      counts: {
        total: state.records.length,
        valid: results.length,
        invalid,
        missing,
        failed,
      },
      results,
      errors,
      on_error: state.settings.on_error,
    };
  }

  private async validCollectedRecords(
    state: AgentJobState,
  ): Promise<JsonObject[]> {
    const collected: JsonObject[] = [];
    for (const record of state.records) {
      const path = runPathFor(state, record);
      if (!(await managedFileExists(path)))
        continue;
      await ensureRealFile(path);
      const value = await readJson(path);
      if (
        !isObject(value)
        || validationErrors(value, state.spec.output_schema).length > 0
      ) {
        continue;
      }
      const merged = Object.create(null) as JsonObject;
      merged[state.id_column_key] = record.id;
      for (const [key, item] of Object.entries(value)) {
        if (key !== state.id_column_key)
          merged[key] = item;
      }
      collected.push(merged);
    }
    return collected;
  }
}

interface ValidationReport extends JsonObject {
  job_id: string;
  generated_at: string;
  valid: boolean;
  counts: JsonObject;
  results: JsonObject[];
  errors: JsonObject[];
  on_error: OnError;
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

function recordForRegistry(
  state: AgentJobState,
  registry: RegistryEntry,
  handle: string,
): AgentJobItemRecord {
  if (state.job_id !== registry.job_id) {
    throw new AgentJobsError(
      'invalid_handle',
      'Handle agent job does not match',
    );
  }
  const index = registry.record_index;
  if (index < 0 || index >= state.records.length) {
    throw new AgentJobsError('invalid_handle', 'Handle row does not exist');
  }
  const record = state.records[index];
  if (record === undefined || record.index !== index || record.handle !== handle) {
    throw new AgentJobsError(
      'invalid_handle',
      'Handle is no longer current',
    );
  }
  return record;
}

function counts(state: AgentJobState): QueueCounts {
  const statuses = new Map<RecordStatus, number>();
  for (const record of state.records) {
    statuses.set(record.status, (statuses.get(record.status) ?? 0) + 1);
  }
  const leased = statuses.get('leased') ?? 0;
  const running = statuses.get('running') ?? 0;
  const skippedValid = statuses.get('skipped_valid') ?? 0;
  const skippedInvalid = statuses.get('skipped_invalid') ?? 0;
  return {
    total: state.records.length,
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

function runPathFor(
  state: AgentJobState,
  record: AgentJobItemRecord,
): string {
  return join(state.output_dir, 'runs', `${record.safe_id}.json`);
}

function errorPathFor(
  state: AgentJobState,
  record: AgentJobItemRecord,
): string {
  return join(state.output_dir, 'errors', `${record.safe_id}.json`);
}

function lockPath(statePath: string): string {
  return `${statePath}.lock`;
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
    await atomicWriteText(
      path,
      `${stringifyStrictJson(records, { pretty: true })}\n`,
    );
    return;
  }
  if (format === 'jsonl') {
    const text = records
      .map(record => `${stringifyStrictJson(record)}\n`)
      .join('');
    await atomicWriteText(path, text);
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
    lines.push(
      fields
        .map(field =>
          csvCell(
            Object.hasOwn(record, field) ? csvValue(record[field]) : '',
          ),
        )
        .join(','),
    );
  }
  await atomicWriteText(path, `${lines.join('\r\n')}\r\n`);
}

function csvValue(value: unknown): string | number | bigint {
  if (value === null || value === undefined)
    return '';
  if (typeof value === 'boolean')
    return value ? 'true' : 'false';
  if (Array.isArray(value) || isObject(value)) {
    return stringifyStrictJson(value);
  }
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
  for (const relative of ['runs', 'errors', '.batch', '.batch/jobs']) {
    await ensureRealDirectory(join(destination, relative), create, false);
  }
}

async function ensureStateOutputLayout(state: AgentJobState): Promise<void> {
  if (typeof state.output_dir !== 'string' || state.output_dir.length === 0) {
    throw new AgentJobsError(
      'invalid_job',
      'Agent job output_dir is missing or invalid',
    );
  }
  if (!isAbsolute(state.output_dir)) {
    throw new AgentJobsError(
      'invalid_job',
      'Agent job output_dir must be absolute',
    );
  }
  await ensureOutputLayout(state.output_dir, false);
}

async function ensureArchiveDirectory(archiveRoot: string): Promise<void> {
  const invalidDirectory = dirname(archiveRoot);
  const historyDirectory = dirname(invalidDirectory);
  const destination = dirname(historyDirectory);
  await ensureOutputLayout(destination, false);
  await ensureRealDirectory(historyDirectory, true, false);
  await ensureRealDirectory(invalidDirectory, true, false);
  await ensureRealDirectory(archiveRoot, true, false);
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
    if (!isMissingFileError(error)) {
      throw unsafeInspectionError('directory', path, error);
    }
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
    if (
      item === null
      || typeof item === 'string'
      || typeof item === 'boolean'
      || typeof item === 'bigint'
    ) {
      return null;
    }
    if (typeof item === 'number') {
      return Number.isFinite(item)
        ? null
        : `${path} contains a non-finite number`;
    }
    if (typeof item !== 'object') {
      return `${path} contains a non-JSON ${typeof item} value`;
    }
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
      if (prototype !== Object.prototype && prototype !== null) {
        return `${path} contains a non-plain object`;
      }
      if (Object.getOwnPropertySymbols(item).length > 0) {
        return `${path} contains a symbol-keyed property`;
      }
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
  const expanded
    = input === '~'
      ? homedir()
      : input.startsWith('~/')
        ? join(homedir(), input.slice(2))
        : input;
  return resolve(expanded);
}

/**
 * Resolve every existing path component through the filesystem, then append any
 * not-yet-created suffix. This mirrors `Path.resolve()` semantics while still
 * allowing prepare to create a new OUTPUT_DIR beneath a symlinked ancestor.
 */
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

/** Make a path absolute without collapsing `..` across a symlink boundary. */
function unresolvedAbsolutePath(input: PathInput): string {
  if (input instanceof URL)
    return fileURLToPath(input);
  const expanded
    = input === '~'
      ? homedir()
      : input.startsWith('~/')
        ? `${homedir()}${sep}${input.slice(2)}`
        : input;
  return isAbsolute(expanded) ? expanded : `${process.cwd()}${sep}${expanded}`;
}

function now(): string {
  return new Date().toISOString();
}

function archiveStamp(date = new Date()): string {
  return date
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '');
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
