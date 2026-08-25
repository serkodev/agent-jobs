import type { CollectFormat, OnError, PrepareOptions } from '@agent-jobs/runtime';
import type { InstallerEnvironment } from './installer.js';

import { writeSync } from 'node:fs';
import process from 'node:process';
import { parseArgs } from 'node:util';

import {
  AgentJobsError,
  AgentJobsRuntime,

  runMcpServer,
  stringifyStrictJson,
} from '@agent-jobs/runtime';
import {

  runInstallerCommand,
} from './installer.js';

const COLLECT_FORMATS: ReadonlySet<CollectFormat> = new Set([
  'none',
  'json',
  'jsonl',
  'csv',
]);
const ON_ERROR_POLICIES: ReadonlySet<OnError> = new Set([
  'stop',
  'continue_successes',
]);

type JsonObject = Record<string, unknown>;
type Writable = Pick<NodeJS.WritableStream, 'write'>;
interface SignalTarget {
  once: (event: 'SIGINT', listener: () => void) => unknown;
  removeListener: (event: 'SIGINT', listener: () => void) => unknown;
}

export interface CliDependencies {
  runtime?: AgentJobsRuntime;
  runtimeFactory?: () => AgentJobsRuntime;
  runMcp?: () => unknown | Promise<unknown>;
  stdout?: Writable;
  stderr?: Writable;
  installer?: Omit<InstallerEnvironment, 'stdout' | 'stderr'>;
}

export interface ProcessCliDependencies extends CliDependencies {
  signalTarget?: SignalTarget;
  exit?: (code: number) => void;
}

interface JobArguments {
  outputDir: string;
  jobId: string;
}

const HELP = `Usage: agent-jobs <command> [options]

Commands:
  init      Initialize Agent Jobs in the current or specified directory
  uninstall Remove files managed by a previous Agent Jobs initialization
  prepare   Validate all input rows and prepare a batch
  next      Issue opaque worker assignments
  status    Inspect batch progress
  validate  Validate committed outputs and write report.json
  collect   Collect valid outputs in input order
  doctor    Check the local installation
  mcp       Run the agent_jobs stdio MCP server
`;

function invalidArguments(message: string): never {
  throw new AgentJobsError('invalid_arguments', message);
}

function requiredString(
  values: Record<string, string | boolean | string[] | boolean[] | undefined>,
  name: string,
): string {
  const value = values[name];
  if (typeof value !== 'string' || value.length === 0) {
    invalidArguments(`Missing required option --${name}`);
  }
  return value;
}

function optionalString(
  values: Record<string, string | boolean | string[] | boolean[] | undefined>,
  name: string,
): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

function optionalInteger(
  values: Record<string, string | boolean | string[] | boolean[] | undefined>,
  name: string,
): number | undefined {
  const raw = optionalString(values, name);
  if (raw === undefined)
    return undefined;
  if (!/^[+-]?\d+$/.test(raw)) {
    invalidArguments(`--${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    invalidArguments(`--${name} must be a safe integer`);
  }
  return value;
}

function assertChoice<T extends string>(
  value: string | undefined,
  name: string,
  choices: ReadonlySet<T>,
): T | undefined {
  if (value !== undefined && !choices.has(value as T)) {
    invalidArguments(
      `Invalid --${name}: ${JSON.stringify(value)}; expected one of ${[
        ...choices,
      ].join(', ')}`,
    );
  }
  return value as T | undefined;
}

function parseStrict(
  args: readonly string[],
  options: NonNullable<Parameters<typeof parseArgs>[0]>['options'],
): Record<string, string | boolean | string[] | boolean[] | undefined> {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options,
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) {
      invalidArguments(`Unexpected positional argument: ${positionals[0]}`);
    }
    return values;
  } catch (error) {
    if (error instanceof AgentJobsError)
      throw error;
    invalidArguments(error instanceof Error ? error.message : String(error));
  }
}

function parseJobArguments(args: readonly string[]): JobArguments {
  const values = parseStrict(args, {
    'output-dir': { type: 'string' },
    'job-id': { type: 'string' },
  });
  return {
    outputDir: requiredString(values, 'output-dir'),
    jobId: requiredString(values, 'job-id'),
  };
}

async function dispatch(
  runtime: AgentJobsRuntime,
  command: string,
  args: readonly string[],
): Promise<JsonObject> {
  if (command === 'prepare') {
    const values = parseStrict(args, {
      'input-data': { type: 'string' },
      'task-spec': { type: 'string' },
      'id-column-key': { type: 'string' },
      'output-dir': { type: 'string' },
      'records-path': { type: 'string' },
      'model': { type: 'string' },
      'reasoning-effort': { type: 'string' },
      'max-concurrency': { type: 'string' },
      'max-retries': { type: 'string' },
      'retry-invalid': { type: 'boolean' },
      'on-error': { type: 'string' },
      'collect-format': { type: 'string' },
      'post-process-model': { type: 'string' },
      'post-process-reasoning-effort': { type: 'string' },
    });
    const onError = assertChoice(
      optionalString(values, 'on-error'),
      'on-error',
      ON_ERROR_POLICIES,
    );
    const collectFormat = assertChoice(
      optionalString(values, 'collect-format'),
      'collect-format',
      COLLECT_FORMATS,
    );
    const options: PrepareOptions = {
      inputData: requiredString(values, 'input-data'),
      taskSpec: requiredString(values, 'task-spec'),
      idColumnKey: requiredString(values, 'id-column-key'),
      outputDir: requiredString(values, 'output-dir'),
      recordsPath: optionalString(values, 'records-path'),
      model: optionalString(values, 'model'),
      reasoningEffort: optionalString(values, 'reasoning-effort'),
      maxConcurrency: optionalInteger(values, 'max-concurrency'),
      maxRetries: optionalInteger(values, 'max-retries'),
      retryInvalid: values['retry-invalid'] === true ? true : undefined,
      onError,
      collectFormat,
      postProcessModel: optionalString(values, 'post-process-model'),
      postProcessReasoningEffort: optionalString(
        values,
        'post-process-reasoning-effort',
      ),
    };
    return runtime.prepare(options);
  }

  if (command === 'next') {
    const values = parseStrict(args, {
      'output-dir': { type: 'string' },
      'job-id': { type: 'string' },
      'count': { type: 'string' },
    });
    const count = optionalInteger(values, 'count') ?? 1;
    return runtime.next(
      requiredString(values, 'output-dir'),
      requiredString(values, 'job-id'),
      { count },
    );
  }

  if (command === 'status') {
    const job = parseJobArguments(args);
    return runtime.status(job.outputDir, job.jobId);
  }

  if (command === 'validate') {
    const job = parseJobArguments(args);
    return runtime.validate(job.outputDir, job.jobId);
  }

  if (command === 'collect') {
    const values = parseStrict(args, {
      'output-dir': { type: 'string' },
      'job-id': { type: 'string' },
      'format': { type: 'string' },
    });
    const format = assertChoice(
      requiredString(values, 'format'),
      'format',
      COLLECT_FORMATS,
    );
    return runtime.collect(
      requiredString(values, 'output-dir'),
      requiredString(values, 'job-id'),
      { format },
    );
  }

  if (command === 'doctor') {
    const values = parseStrict(args, {
      'output-dir': { type: 'string' },
      'task-spec': { type: 'string' },
    });
    return runtime.doctor({
      outputDir: optionalString(values, 'output-dir'),
      taskSpec: optionalString(values, 'task-spec'),
    });
  }

  invalidArguments(`Unsupported command: ${command}`);
}

function emit(stream: Writable, payload: JsonObject): void {
  stream.write(`${stringifyStrictJson(payload)}\n`);
}

function domainErrorPayload(error: AgentJobsError): JsonObject {
  return { ok: false, error: error.asDict() };
}

/** Run the public CLI and return, rather than force, its process exit status. */
export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const command = argv[0];

  if (command === '--help' || command === '-h') {
    stdout.write(HELP);
    return 0;
  }

  try {
    if (!command)
      invalidArguments('A command is required');
    if (argv.slice(1).includes('--help') || argv.slice(1).includes('-h')) {
      stdout.write(HELP);
      return 0;
    }
    if (command === 'mcp') {
      if (argv.length !== 1)
        invalidArguments('The mcp command accepts no options');
      await (dependencies.runMcp ?? runMcpServer)();
      return 0;
    }
    if (command === 'init' || command === 'uninstall') {
      return await runInstallerCommand(command, argv.slice(1), {
        ...dependencies.installer,
        stdout,
        stderr,
      });
    }

    const runtime
      = dependencies.runtime
        ?? (dependencies.runtimeFactory ?? (() => new AgentJobsRuntime()))();
    const result = await dispatch(runtime, command, argv.slice(1));
    emit(stdout, { ok: true, ...result });
    return command === 'doctor' && result.ok === false ? 2 : 0;
  } catch (error) {
    if (command === 'mcp') {
      if (error instanceof AgentJobsError) {
        stderr.write(`${error.code}: ${error.message}\n`);
        return 2;
      }
      stderr.write(
        `MCP server failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    if (error instanceof AgentJobsError) {
      emit(stdout, domainErrorPayload(error));
      return 2;
    }
    emit(stdout, {
      ok: false,
      error: {
        code: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return 1;
  }
}

/** Run the process-facing CLI with a stable Ctrl-C JSON contract. */
export async function runProcessCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: ProcessCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const signalTarget = dependencies.signalTarget ?? process;
  const exit = dependencies.exit ?? ((code: number) => process.exit(code));
  let interrupted = false;
  const guardedStdout: Writable = {
    write(chunk: unknown): boolean {
      if (interrupted)
        return true;
      return stdout.write(String(chunk));
    },
  };
  const onInterrupt = (): void => {
    if (interrupted)
      return;
    interrupted = true;
    if (argv[0] === 'mcp') {
      writeSignalSafe(stderr, 'MCP server interrupted\n');
    } else {
      writeSignalSafe(
        stdout,
        `${stringifyStrictJson({
          ok: false,
          error: {
            code: 'interrupted',
            message: 'Batch command interrupted by SIGINT',
          },
        })}\n`,
      );
    }
    exit(130);
  };

  signalTarget.once('SIGINT', onInterrupt);
  try {
    const exitCode = await runCli(argv, {
      ...dependencies,
      stdout: guardedStdout,
      stderr,
    });
    return interrupted ? 130 : exitCode;
  } finally {
    signalTarget.removeListener('SIGINT', onInterrupt);
  }
}

function writeSignalSafe(stream: Writable, value: string): void {
  const fd = (stream as Writable & { fd?: unknown }).fd;
  if (typeof fd === 'number' && Number.isInteger(fd)) {
    writeSync(fd, value);
    return;
  }
  stream.write(value);
}

export const main = runProcessCli;
