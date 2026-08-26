import type {
  RecordSchemaConfig,
  RecordValidationSchema,
} from './schema.js';
import type { FilePath } from './storage.js';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as v from 'valibot';
import { parseDocument } from 'yaml';

import { AgentJobsError } from './errors.js';
import {
  isPreciseNumber,
  preserveYamlNumberPrecision,
} from './numbers.js';
import {
  nonBlankStringSchema,
  recordSchemaConfigSchema,
  valibotDiagnostics,
} from './schema-validation.js';
import { parseRecordSchema } from './schema.js';
import { readUtf8File } from './storage.js';

const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const workerSettingSchema = v.optional(v.nullable(nonBlankStringSchema));
const taskMetadataSchema = v.strictObject({
  name: v.optional(nonBlankStringSchema),
  version: v.optional(v.union([
    v.string(),
    v.pipe(v.number(), v.finite()),
    v.bigint(),
    v.custom(isPreciseNumber),
  ]), 1),
  description: v.optional(v.nullable(v.string()), null),
  input: v.optional(recordSchemaConfigSchema, () => ({ loose: true, schema: {} })),
  output: recordSchemaConfigSchema,
  defaults: v.optional(v.nullable(v.strictObject({
    model: workerSettingSchema,
    reasoning_effort: workerSettingSchema,
  })), null),
  model: workerSettingSchema,
  reasoning_effort: workerSettingSchema,
});

export class TaskSpec {
  readonly path: string;
  readonly name: string;
  readonly version: string;
  readonly description: string | null;
  readonly instructions: string;
  readonly input: RecordSchemaConfig;
  readonly output: RecordSchemaConfig;
  readonly inputValidation: RecordValidationSchema;
  readonly outputValidation: RecordValidationSchema;
  readonly model: string | null;
  readonly reasoningEffort: string | null;

  constructor(options: {
    path: string;
    name: string;
    version: string;
    description: string | null;
    instructions: string;
    input: RecordSchemaConfig;
    output: RecordSchemaConfig;
    inputValidation: RecordValidationSchema;
    outputValidation: RecordValidationSchema;
    model: string | null;
    reasoningEffort: string | null;
  }) {
    this.path = options.path;
    this.name = options.name;
    this.version = options.version;
    this.description = options.description;
    this.instructions = options.instructions;
    this.input = options.input;
    this.output = options.output;
    this.inputValidation = options.inputValidation;
    this.outputValidation = options.outputValidation;
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
  }

  workerPayload(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      name: this.name,
      version: this.version,
      instructions: this.instructions,
      output: this.output,
    };
    if (this.description)
      result.description = this.description;
    return result;
  }
}

/** Load one Markdown task specification with mandatory YAML frontmatter. */
export async function loadSpec(path: FilePath): Promise<TaskSpec> {
  const source = resolveSpecPath(path);
  await assertSpecFile(source);

  let text: string;
  try {
    text = await readUtf8File(source);
  } catch (error) {
    throw new AgentJobsError(
      'invalid_spec',
      `Could not read task spec: ${errorMessage(error)}`,
    );
  }
  const { metadata, instructions } = parseFrontmatter(text);
  assertRequiredMetadata(metadata);
  if (instructions.trim().length === 0) {
    throw new AgentJobsError(
      'invalid_spec',
      'Task spec Markdown instructions must not be empty',
    );
  }

  const parsedMetadata = v.safeParse(taskMetadataSchema, metadata, {
    abortEarly: false,
  });
  if (!parsedMetadata.success) {
    throw new AgentJobsError(
      'invalid_spec',
      'Task spec frontmatter is invalid',
      valibotDiagnostics(parsedMetadata.issues),
    );
  }

  const config = parsedMetadata.output;
  const parsedInput = parseRecordSchema(config.input.schema, 'input.schema');
  const parsedOutput = parseRecordSchema(config.output.schema, 'output.schema');
  const defaults = config.defaults ?? {};

  return new TaskSpec({
    path: source,
    name: config.name === undefined
      ? deriveSpecName(source)
      : config.name.trim(),
    version: String(config.version),
    description: config.description,
    instructions: instructions.trim(),
    input: {
      loose: config.input.loose,
      schema: parsedInput.fields,
    },
    output: {
      loose: config.output.loose,
      schema: parsedOutput.fields,
    },
    inputValidation: parsedInput.validation,
    outputValidation: parsedOutput.validation,
    model: Object.hasOwn(config, 'model')
      ? (config.model ?? null)
      : (defaults.model ?? null),
    reasoningEffort: Object.hasOwn(config, 'reasoning_effort')
      ? (config.reasoning_effort ?? null)
      : (defaults.reasoning_effort ?? null),
  });
}

async function assertSpecFile(source: string): Promise<void> {
  try {
    const info = await stat(source);
    if (!info.isFile())
      throw new Error('not a regular file');
  } catch {
    throw new AgentJobsError(
      'spec_not_found',
      `Task spec does not exist: ${source}`,
      { path: source },
    );
  }
}

function assertRequiredMetadata(metadata: Record<string, unknown>): void {
  const missing = ['output'].filter(
    key => !Object.hasOwn(metadata, key),
  );
  if (missing.length > 0) {
    throw new AgentJobsError(
      'invalid_spec',
      'Task spec frontmatter is missing required keys',
      { missing },
    );
  }
}

function deriveSpecName(source: string): string {
  const filename = basename(source);
  const lastDot = filename.lastIndexOf('.');
  const name = (lastDot < 0 ? filename : filename.slice(0, lastDot)).trim();
  if (name.length === 0) {
    throw new AgentJobsError(
      'invalid_spec',
      'Task spec name could not be derived from its filename',
      { path: source },
    );
  }
  return name;
}

function parseFrontmatter(text: string): {
  metadata: Record<string, unknown>;
  instructions: string;
} {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length === 0 || lines[0]?.trim() !== '---') {
    throw new AgentJobsError(
      'invalid_spec',
      'Runnable task specs must begin with YAML frontmatter',
    );
  }
  const closing = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---',
  );
  if (closing < 0) {
    throw new AgentJobsError(
      'invalid_spec',
      'Task spec YAML frontmatter is not closed',
    );
  }

  let metadata: unknown;
  try {
    const document = parseDocument(lines.slice(1, closing).join('\n'), {
      intAsBigInt: true,
      keepSourceTokens: true,
      prettyErrors: true,
      schema: 'core',
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0)
      throw new Error(document.errors.map(error => error.message).join('; '));
    preserveYamlNumberPrecision(document);
    const raw: unknown = document.toJS({ mapAsMap: true, maxAliasCount: 100 });
    metadata = normalizeYamlObject(raw);
  } catch (error) {
    throw new AgentJobsError(
      'invalid_spec',
      `Invalid YAML frontmatter: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(metadata)) {
    throw new AgentJobsError(
      'invalid_spec',
      'Task spec frontmatter must be an object',
    );
  }
  return {
    metadata,
    instructions: lines.slice(closing + 1).join('\n'),
  };
}

function normalizeYamlObject(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'bigint') {
    if (value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT)
      return Number(value);
    return value;
  }
  if (isPreciseNumber(value))
    return value;
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('non-finite YAML number');
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(
      `frontmatter contains a non-JSON value of type ${typeof value}`,
    );
  }
  if (seen.has(value))
    throw new Error('cyclic YAML aliases are not supported');
  seen.add(value);

  let normalized: unknown;
  if (Array.isArray(value)) {
    normalized = value.map(item => normalizeYamlObject(item, seen));
  } else if (value instanceof Map) {
    const result = safeObject();
    for (const [key, item] of value.entries()) {
      if (typeof key !== 'string')
        throw new TypeError('frontmatter mapping keys must be strings');
      defineSafe(result, key, normalizeYamlObject(item, seen));
    }
    normalized = result;
  } else {
    const result = safeObject();
    for (const [key, item] of Object.entries(value))
      defineSafe(result, key, normalizeYamlObject(item, seen));
    normalized = result;
  }
  seen.delete(value);
  return normalized;
}

function resolveSpecPath(value: FilePath): string {
  if (value instanceof URL)
    return fileURLToPath(value);
  if (value === '~')
    return homedir();
  if (value.startsWith('~/'))
    return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeObject(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function defineSafe(
  object: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(object, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
