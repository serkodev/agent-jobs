/** Markdown task-spec parsing and deterministic JSON Schema 2020-12 validation. */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import formatsPlugin from "ajv-formats";
import { parseDocument } from "yaml";

import { BatchTasksError } from "./errors.js";
import { readUtf8File, stringifyStrictJson, type FilePath } from "./storage.js";

export type JsonSchema = Record<string, unknown>;

const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const EXACT_KEYWORDS = {
  const: "xBatchExactConst",
  enum: "xBatchExactEnum",
  exclusiveMaximum: "xBatchExactExclusiveMaximum",
  exclusiveMinimum: "xBatchExactExclusiveMinimum",
  maximum: "xBatchExactMaximum",
  minimum: "xBatchExactMinimum",
  multipleOf: "xBatchExactMultipleOf",
  uniqueItems: "xBatchExactUniqueItems",
} as const;

const EXACT_KEYWORD_NAMES: ReadonlySet<string> = new Set(Object.values(EXACT_KEYWORDS));
const SINGLE_SUBSCHEMA_KEYS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const ARRAY_SUBSCHEMA_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const MAP_SUBSCHEMA_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

interface Rational {
  numerator: bigint;
  denominator: bigint;
}

interface RationalConfig {
  numerator: string;
  denominator: string;
}

interface ExactValidationContext {
  root: unknown;
  normalizedRoot: unknown;
}

export interface ValidationDiagnostic {
  path: string;
  message: string;
  validator: string;
}

export class TaskSpec {
  readonly path: string;
  readonly name: string;
  readonly version: string;
  readonly description: string | null;
  readonly instructions: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly model: string | null;
  readonly reasoningEffort: string | null;

  constructor(options: {
    path: string;
    name: string;
    version: string;
    description: string | null;
    instructions: string;
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    model: string | null;
    reasoningEffort: string | null;
  }) {
    this.path = options.path;
    this.name = options.name;
    this.version = options.version;
    this.description = options.description;
    this.instructions = options.instructions;
    this.inputSchema = options.inputSchema;
    this.outputSchema = options.outputSchema;
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
  }

  workerPayload(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      name: this.name,
      version: this.version,
      instructions: this.instructions,
      output_schema: this.outputSchema,
    };
    if (this.description) result.description = this.description;
    return result;
  }
}

/** Load one Markdown task specification with mandatory YAML frontmatter. */
export async function loadSpec(path: FilePath): Promise<TaskSpec> {
  const source = resolveSpecPath(path);
  try {
    const info = await stat(source);
    if (!info.isFile()) throw new Error("not a regular file");
  } catch {
    throw new BatchTasksError(
      "spec_not_found",
      `Task spec does not exist: ${source}`,
      { path: source },
    );
  }

  let text: string;
  try {
    text = await readUtf8File(source);
  } catch (error) {
    throw new BatchTasksError(
      "invalid_spec",
      `Could not read task spec: ${errorMessage(error)}`,
    );
  }
  const { metadata, instructions } = parseFrontmatter(text);

  const missing = ["name", "input_schema", "output_schema"].filter(
    (key) => !Object.prototype.hasOwnProperty.call(metadata, key),
  );
  if (missing.length > 0) {
    throw new BatchTasksError(
      "invalid_spec",
      "Task spec frontmatter is missing required keys",
      { missing },
    );
  }

  const name = metadata.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new BatchTasksError(
      "invalid_spec",
      "Task spec name must be a non-empty string",
    );
  }
  if (instructions.trim().length === 0) {
    throw new BatchTasksError(
      "invalid_spec",
      "Task spec Markdown instructions must not be empty",
    );
  }

  const inputSchema = metadata.input_schema;
  const outputSchema = metadata.output_schema;
  if (!isRecord(inputSchema) || !isRecord(outputSchema)) {
    throw new BatchTasksError(
      "invalid_spec",
      "input_schema and output_schema must be objects",
    );
  }
  checkSchema(inputSchema, "input_schema");
  checkSchema(outputSchema, "output_schema");
  if (inputSchema.type !== "object" || outputSchema.type !== "object") {
    throw new BatchTasksError(
      "invalid_spec",
      "v1 input_schema and output_schema must have type: object",
    );
  }
  if (!isRecord(inputSchema.properties)) {
    throw new BatchTasksError(
      "invalid_spec",
      "input_schema.properties must be an object for field projection",
    );
  }

  let defaults: Record<string, unknown> = {};
  if (metadata.defaults !== undefined && metadata.defaults !== null) {
    if (!isRecord(metadata.defaults)) {
      throw new BatchTasksError(
        "invalid_spec",
        "defaults must be an object when provided",
      );
    }
    defaults = metadata.defaults;
  }
  const model = Object.prototype.hasOwnProperty.call(metadata, "model")
    ? metadata.model
    : (defaults.model ?? null);
  const reasoningEffort = Object.prototype.hasOwnProperty.call(
    metadata,
    "reasoning_effort",
  )
    ? metadata.reasoning_effort
    : (defaults.reasoning_effort ?? null);
  for (const [key, value] of [
    ["model", model],
    ["reasoning_effort", reasoningEffort],
  ] as const) {
    if (value !== null && (typeof value !== "string" || value.trim().length === 0)) {
      throw new BatchTasksError(
        "invalid_spec",
        `${key} must be a non-empty string`,
      );
    }
  }
  const selectedModel = typeof model === "string" ? model : null;
  const selectedReasoningEffort =
    typeof reasoningEffort === "string" ? reasoningEffort : null;

  const version = Object.prototype.hasOwnProperty.call(metadata, "version")
    ? metadata.version
    : 1;
  if (
    typeof version === "boolean" ||
    !["string", "number", "bigint"].includes(typeof version) ||
    (typeof version === "number" && !Number.isFinite(version))
  ) {
    throw new BatchTasksError(
      "invalid_spec",
      "Task spec version must be a string or number",
    );
  }
  const description = metadata.description ?? null;
  if (description !== null && typeof description !== "string") {
    throw new BatchTasksError(
      "invalid_spec",
      "Task spec description must be a string",
    );
  }

  return new TaskSpec({
    path: source,
    name: name.trim(),
    version: String(version),
    description,
    instructions: instructions.trim(),
    inputSchema,
    outputSchema,
    model: selectedModel,
    reasoningEffort: selectedReasoningEffort,
  });
}

/** Return stable, JSON-serializable JSON Schema validation diagnostics. */
export function validationErrors(
  instance: unknown,
  schema: JsonSchema,
): ValidationDiagnostic[] {
  const normalizedInstance = normalizeInstanceForAjv(instance);
  const transformedSchema = transformSchemaForExactNumbers(schema) as JsonSchema;
  let validator: ValidateFunction;
  try {
    validator = createAjv({
      root: instance,
      normalizedRoot: normalizedInstance,
    }).compile(transformedSchema);
  } catch (error) {
    if (error instanceof BatchTasksError) throw error;
    throw schemaReferenceError(error);
  }

  let valid: boolean;
  try {
    valid = validator(normalizedInstance) as boolean;
  } catch (error) {
    if (error instanceof BatchTasksError) throw error;
    throw schemaReferenceError(error);
  }
  if (valid) return [];

  return (validator.errors ?? [])
    .map(toDiagnostic)
    .sort((left, right) =>
      left.path === right.path
        ? left.validator.localeCompare(right.validator, "en")
        : left.path.localeCompare(right.path, "en"),
    );
}

function parseFrontmatter(text: string): {
  metadata: Record<string, unknown>;
  instructions: string;
} {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length === 0 || lines[0]?.trim() !== "---") {
    throw new BatchTasksError(
      "invalid_spec",
      "Runnable task specs must begin with YAML frontmatter",
    );
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) {
    throw new BatchTasksError(
      "invalid_spec",
      "Task spec YAML frontmatter is not closed",
    );
  }

  let metadata: unknown;
  try {
    const document = parseDocument(lines.slice(1, closing).join("\n"), {
      intAsBigInt: true,
      prettyErrors: true,
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      throw new Error(document.errors.map((error) => error.message).join("; "));
    }
    const raw: unknown = document.toJS({ mapAsMap: true, maxAliasCount: 100 });
    metadata = normalizeYamlObject(raw);
  } catch (error) {
    throw new BatchTasksError(
      "invalid_spec",
      `Invalid YAML frontmatter: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(metadata)) {
    throw new BatchTasksError(
      "invalid_spec",
      "Task spec frontmatter must be an object",
    );
  }
  return {
    metadata,
    instructions: lines.slice(closing + 1).join("\n"),
  };
}

function checkSchema(schema: JsonSchema, name: string): void {
  try {
    stringifyStrictJson(schema);
  } catch (error) {
    throw new BatchTasksError(
      "invalid_spec",
      `${name} must contain only JSON-compatible values: ${errorMessage(error)}`,
    );
  }

  const ajv = createAjv({ root: undefined, normalizedRoot: undefined });
  const metadataSchema = normalizeSchemaForMeta(schema) as JsonSchema;
  let schemaValid: boolean;
  try {
    schemaValid = ajv.validateSchema(metadataSchema) as boolean;
  } catch (error) {
    throw new BatchTasksError(
      "invalid_spec",
      `${name} is not a valid JSON Schema: ${errorMessage(error)}`,
    );
  }
  if (!schemaValid) {
    throw new BatchTasksError(
      "invalid_spec",
      `${name} is not a valid JSON Schema: ${ajv.errorsText(ajv.errors, { separator: "; " })}`,
    );
  }

  try {
    ajv.compile(transformSchemaForExactNumbers(schema) as JsonSchema);
  } catch (error) {
    if (error instanceof BatchTasksError) throw error;
    throw new BatchTasksError(
      "invalid_schema_reference",
      `${name} contains a non-local or unresolved $ref`,
      {
        schema: name,
        reference: missingReference(error),
        reason: errorMessage(error),
      },
    );
  }
}

function createAjv(context: ExactValidationContext): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    logger: false,
    strict: false,
    validateFormats: true,
  });
  const addFormats = formatsPlugin as unknown as (instance: Ajv2020) => Ajv2020;
  addFormats(ajv);
  addExactKeywords(ajv, context);
  return ajv;
}

function toDiagnostic(error: ErrorObject): ValidationDiagnostic {
  const originalKeyword = Object.entries(EXACT_KEYWORDS).find(
    ([, replacement]) => replacement === error.keyword,
  )?.[0];
  return {
    path: error.instancePath,
    message: error.message ?? "schema validation failed",
    validator: originalKeyword ?? error.keyword,
  };
}

function schemaReferenceError(error: unknown): BatchTasksError {
  return new BatchTasksError(
    "invalid_schema_reference",
    "JSON Schema contains an unresolved or cyclic reference",
    { reason: errorMessage(error) },
  );
}

function missingReference(error: unknown): string | undefined {
  if (error !== null && typeof error === "object") {
    if ("missingRef" in error && typeof error.missingRef === "string") {
      return error.missingRef;
    }
    if ("missingSchema" in error && typeof error.missingSchema === "string") {
      return error.missingSchema;
    }
  }
  return undefined;
}

function normalizeInstanceForAjv(
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (typeof value === "bigint") return 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value;
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new BatchTasksError(
        "inexact_number",
        "Unsafe JavaScript integer cannot be schema-validated exactly; use bigint",
        { value: value.toString() },
      );
    }
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  const previous = seen.get(value);
  if (previous !== undefined) return previous;
  if (Array.isArray(value)) {
    const array: unknown[] = [];
    seen.set(value, array);
    for (const item of value) array.push(normalizeInstanceForAjv(item, seen));
    return array;
  }
  const entries: Array<[string, unknown]> = [];
  const object = safeObjectEntries(entries);
  seen.set(value, object);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(object, key, {
      configurable: true,
      enumerable: true,
      value: normalizeInstanceForAjv(item, seen),
      writable: true,
    });
  }
  return object;
}

function normalizeSchemaForMeta(
  schema: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (typeof schema === "boolean") return schema;
  if (!isRecord(schema)) return normalizeSchemaLiteralForMeta(schema);
  const previous = seen.get(schema);
  if (previous !== undefined) return previous;
  const object = safeObjectEntries([]);
  seen.set(schema, object);
  for (const [key, value] of Object.entries(schema)) {
    if (key === "const") {
      defineSafe(object, key, null);
      continue;
    }
    if (key === "enum" && Array.isArray(value)) {
      defineSafe(
        object,
        key,
        value.map((_, index) => `__batch_enum_item_${index}`),
      );
      continue;
    }
    if (SINGLE_SUBSCHEMA_KEYS.has(key)) {
      defineSafe(
        object,
        key,
        typeof value === "boolean" || isRecord(value)
          ? normalizeSchemaForMeta(value, seen)
          : normalizeSchemaLiteralForMeta(value),
      );
      continue;
    }
    if (ARRAY_SUBSCHEMA_KEYS.has(key) && Array.isArray(value)) {
      defineSafe(
        object,
        key,
        value.map((item) => normalizeSchemaForMeta(item, seen)),
      );
      continue;
    }
    if (MAP_SUBSCHEMA_KEYS.has(key) && isRecord(value)) {
      defineSafe(
        object,
        key,
        safeObjectEntries(
          Object.entries(value).map(([name, item]) => [
            name,
            normalizeSchemaForMeta(item, seen),
          ]),
        ),
      );
      continue;
    }
    if (key === "dependencies" && isRecord(value)) {
      defineSafe(
        object,
        key,
        safeObjectEntries(
          Object.entries(value).map(([name, item]) => [
            name,
            Array.isArray(item)
              ? normalizeSchemaLiteralForMeta(item)
              : normalizeSchemaForMeta(item, seen),
          ]),
        ),
      );
      continue;
    }
    defineSafe(object, key, normalizeSchemaLiteralForMeta(value));
  }
  return object;
}

function normalizeSchemaLiteralForMeta(
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (typeof value === "bigint") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    return value < 0n ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new BatchTasksError(
        "inexact_numeric_schema",
        "Unsafe JavaScript integer in JSON Schema is ambiguous; use bigint",
        { value: value.toString() },
      );
    }
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  const previous = seen.get(value);
  if (previous !== undefined) return previous;
  if (Array.isArray(value)) {
    const array: unknown[] = [];
    seen.set(value, array);
    for (const item of value) array.push(normalizeSchemaLiteralForMeta(item, seen));
    return array;
  }
  const object = safeObjectEntries([]);
  seen.set(value, object);
  for (const [key, item] of Object.entries(value)) {
    defineSafe(object, key, normalizeSchemaLiteralForMeta(item, seen));
  }
  return object;
}

function transformSchemaForExactNumbers(
  schema: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (typeof schema === "boolean") return schema;
  if (!isRecord(schema)) return schema;
  const previous = seen.get(schema);
  if (previous !== undefined) return previous;
  const transformed = safeObjectEntries([]);
  seen.set(schema, transformed);

  for (const [key, value] of Object.entries(schema)) {
    if (EXACT_KEYWORD_NAMES.has(key)) {
      throw new BatchTasksError(
        "invalid_spec",
        `JSON Schema uses reserved internal keyword: ${key}`,
      );
    }
    if (key in EXACT_KEYWORDS) {
      const replacement = EXACT_KEYWORDS[key as keyof typeof EXACT_KEYWORDS];
      const encoded = encodeExactKeyword(key, value);
      if (encoded !== undefined) defineSafe(transformed, replacement, encoded);
      continue;
    }
    if (SINGLE_SUBSCHEMA_KEYS.has(key)) {
      defineSafe(
        transformed,
        key,
        typeof value === "boolean" || isRecord(value)
          ? transformSchemaForExactNumbers(value, seen)
          : normalizeSchemaLiteral(value),
      );
      continue;
    }
    if (ARRAY_SUBSCHEMA_KEYS.has(key) && Array.isArray(value)) {
      defineSafe(
        transformed,
        key,
        value.map((item) => transformSchemaForExactNumbers(item, seen)),
      );
      continue;
    }
    if (MAP_SUBSCHEMA_KEYS.has(key) && isRecord(value)) {
      defineSafe(
        transformed,
        key,
        safeObjectEntries(
          Object.entries(value).map(([name, item]) => [
            name,
            transformSchemaForExactNumbers(item, seen),
          ]),
        ),
      );
      continue;
    }
    if (key === "dependencies" && isRecord(value)) {
      defineSafe(
        transformed,
        key,
        safeObjectEntries(
          Object.entries(value).map(([name, item]) => [
            name,
            Array.isArray(item)
              ? normalizeSchemaLiteral(item)
              : transformSchemaForExactNumbers(item, seen),
          ]),
        ),
      );
      continue;
    }
    defineSafe(transformed, key, normalizeSchemaLiteral(value));
  }
  preserveProtoPropertyForAjv(transformed);
  return transformed;
}

function preserveProtoPropertyForAjv(schema: Record<string, unknown>): void {
  const properties = schema.properties;
  const existingPatterns = isRecord(schema.patternProperties)
    ? schema.patternProperties
    : safeObjectEntries([]);
  let changed = false;

  if (Object.hasOwn(existingPatterns, "__proto__")) {
    mergePatternSchema(
      existingPatterns,
      "(?:__proto__)",
      existingPatterns.__proto__,
    );
    changed = true;
  }
  if (isRecord(properties) && Object.hasOwn(properties, "__proto__")) {
    mergePatternSchema(existingPatterns, "^__proto__$", properties.__proto__);
    changed = true;
  }
  if (changed) defineSafe(schema, "patternProperties", existingPatterns);
}

function mergePatternSchema(
  patterns: Record<string, unknown>,
  pattern: string,
  additionalSchema: unknown,
): void {
  if (Object.hasOwn(patterns, pattern)) {
    defineSafe(patterns, pattern, {
      allOf: [patterns[pattern], additionalSchema],
    });
  } else {
    defineSafe(patterns, pattern, additionalSchema);
  }
}

function encodeExactKeyword(key: string, value: unknown): unknown {
  if (
    key === "minimum" ||
    key === "maximum" ||
    key === "exclusiveMinimum" ||
    key === "exclusiveMaximum" ||
    key === "multipleOf"
  ) {
    return rationalConfig(schemaRational(value));
  }
  if (key === "const") {
    return { fingerprint: exactFingerprint(value, new WeakSet<object>(), true) };
  }
  if (key === "enum") {
    if (!Array.isArray(value)) return { fingerprints: [] };
    const fingerprints = value.map((item) =>
      exactFingerprint(item, new WeakSet<object>(), true),
    );
    if (new Set(fingerprints).size !== fingerprints.length) {
      throw new BatchTasksError(
        "invalid_spec",
        "JSON Schema enum values must be unique",
      );
    }
    return { fingerprints };
  }
  if (key === "uniqueItems") {
    return value === true ? { enabled: true } : undefined;
  }
  return undefined;
}

function normalizeSchemaLiteral(
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (typeof value === "bigint") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    return value < 0n ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new BatchTasksError(
        "inexact_numeric_schema",
        "Unsafe JavaScript integer in JSON Schema is ambiguous; use bigint",
        { value: value.toString() },
      );
    }
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  const previous = seen.get(value);
  if (previous !== undefined) return previous;
  if (Array.isArray(value)) {
    const array: unknown[] = [];
    seen.set(value, array);
    for (const item of value) array.push(normalizeSchemaLiteral(item, seen));
    return array;
  }
  const object = safeObjectEntries([]);
  seen.set(value, object);
  for (const [key, item] of Object.entries(value)) {
    defineSafe(object, key, normalizeSchemaLiteral(item, seen));
  }
  return object;
}

function addExactKeywords(ajv: Ajv2020, context: ExactValidationContext): void {
  const sourceValue = (data: unknown, path: string): unknown => {
    const normalizedAtPath = valueAtPointer(context.normalizedRoot, path);
    return data === normalizedAtPath ? valueAtPointer(context.root, path) : data;
  };
  const addBound = (
    keyword: string,
    predicate: (comparison: number) => boolean,
  ): void => {
    ajv.addKeyword({
      keyword,
      schemaType: "object",
      errors: false,
      compile(schema: RationalConfig) {
        const bound = rationalFromConfig(schema);
        return (data: unknown, dataContext?: { instancePath?: string }) => {
          const exactData = numericRational(
            sourceValue(data, dataContext?.instancePath ?? ""),
          );
          return exactData === null || predicate(compareRationals(exactData, bound));
        };
      },
    });
  };

  addBound(EXACT_KEYWORDS.minimum, (comparison) => comparison >= 0);
  addBound(EXACT_KEYWORDS.maximum, (comparison) => comparison <= 0);
  addBound(EXACT_KEYWORDS.exclusiveMinimum, (comparison) => comparison > 0);
  addBound(EXACT_KEYWORDS.exclusiveMaximum, (comparison) => comparison < 0);

  ajv.addKeyword({
    keyword: EXACT_KEYWORDS.multipleOf,
    schemaType: "object",
    errors: false,
    compile(schema: RationalConfig) {
      const divisor = rationalFromConfig(schema);
      return (data: unknown, dataContext?: { instancePath?: string }) => {
        const exactData = numericRational(
          sourceValue(data, dataContext?.instancePath ?? ""),
        );
        if (exactData === null) return true;
        const numerator = exactData.numerator * divisor.denominator;
        const denominator = exactData.denominator * divisor.numerator;
        return denominator !== 0n && numerator % denominator === 0n;
      };
    },
  });

  ajv.addKeyword({
    keyword: EXACT_KEYWORDS.const,
    schemaType: "object",
    errors: false,
    compile(schema: { fingerprint: string }) {
      return (data: unknown, dataContext?: { instancePath?: string }) =>
        exactFingerprint(sourceValue(data, dataContext?.instancePath ?? "")) ===
        schema.fingerprint;
    },
  });

  ajv.addKeyword({
    keyword: EXACT_KEYWORDS.enum,
    schemaType: "object",
    errors: false,
    compile(schema: { fingerprints: string[] }) {
      const accepted = new Set(schema.fingerprints);
      return (data: unknown, dataContext?: { instancePath?: string }) =>
        accepted.has(
          exactFingerprint(sourceValue(data, dataContext?.instancePath ?? "")),
        );
    },
  });

  ajv.addKeyword({
    keyword: EXACT_KEYWORDS.uniqueItems,
    schemaType: "object",
    errors: false,
    compile() {
      return (data: unknown, dataContext?: { instancePath?: string }) => {
        const value = sourceValue(data, dataContext?.instancePath ?? "");
        if (!Array.isArray(value)) return true;
        const seen = new Set<string>();
        for (const item of value) {
          const fingerprint = exactFingerprint(item);
          if (seen.has(fingerprint)) return false;
          seen.add(fingerprint);
        }
        return true;
      };
    },
  });
}

function schemaRational(value: unknown): Rational {
  const rational = numericRational(value, true);
  if (rational === null) {
    throw new BatchTasksError(
      "invalid_spec",
      "Numeric JSON Schema keyword must contain a finite number",
    );
  }
  return rational;
}

function numericRational(value: unknown, schema = false): Rational | null {
  if (typeof value === "bigint") return { numerator: value, denominator: 1n };
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new BatchTasksError(
      schema ? "inexact_numeric_schema" : "inexact_number",
      schema
        ? "Unsafe JavaScript integer in JSON Schema is ambiguous; use bigint"
        : "Unsafe JavaScript integer cannot be schema-validated exactly; use bigint",
      { value: value.toString() },
    );
  }
  return rationalFromDecimal(value.toString());
}

function rationalFromDecimal(value: string): Rational {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!match) throw new Error(`Not a finite decimal number: ${value}`);
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  const digits = `${match[2]}${fraction}`;
  let numerator = BigInt(digits || "0");
  if (match[1] === "-") numerator = -numerator;
  const scale = fraction.length - exponent;
  let denominator = 1n;
  if (scale <= 0) numerator *= 10n ** BigInt(-scale);
  else denominator = 10n ** BigInt(scale);
  return reduceRational({ numerator, denominator });
}

function reduceRational(value: Rational): Rational {
  const divisor = greatestCommonDivisor(
    value.numerator < 0n ? -value.numerator : value.numerator,
    value.denominator,
  );
  return {
    numerator: value.numerator / divisor,
    denominator: value.denominator / divisor,
  };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a === 0n ? 1n : a;
}

function rationalConfig(value: Rational): RationalConfig {
  const reduced = reduceRational(value);
  return {
    numerator: reduced.numerator.toString(10),
    denominator: reduced.denominator.toString(10),
  };
}

function rationalFromConfig(value: RationalConfig): Rational {
  return {
    numerator: BigInt(value.numerator),
    denominator: BigInt(value.denominator),
  };
}

function compareRationals(left: Rational, right: Rational): number {
  const comparison =
    left.numerator * right.denominator - right.numerator * left.denominator;
  return comparison < 0n ? -1 : comparison > 0n ? 1 : 0;
}

function exactFingerprint(
  value: unknown,
  seen = new WeakSet<object>(),
  schemaNumbers = false,
): string {
  const numeric = numericRational(value, schemaNumbers);
  if (numeric !== null) {
    const reduced = reduceRational(numeric);
    return `number:${reduced.numerator}/${reduced.denominator}`;
  }
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean:${value ? "1" : "0"}`;
  if (typeof value !== "object") return `${typeof value}:${String(value)}`;
  if (seen.has(value)) throw new Error("cyclic values cannot be compared exactly");
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `array:[${value
      .map((item) => exactFingerprint(item, seen, schemaNumbers))
      .join(",")}]`;
  } else {
    const entries = Object.keys(value)
      .sort(compareCodePoints)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${exactFingerprint(
            (value as Record<string, unknown>)[key],
            seen,
            schemaNumbers,
          )}`,
      );
    result = `object:{${entries.join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function valueAtPointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  let current = root;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) current = current[Number(token)];
    else if (isRecord(current) && Object.hasOwn(current, token)) current = current[token];
    else return undefined;
  }
  return current;
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

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function normalizeYamlObject(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "bigint") {
    if (value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT) return Number(value);
    return value;
  }
  if (value === null || ["string", "boolean"].includes(typeof value)) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite YAML number");
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`frontmatter contains a non-JSON value of type ${typeof value}`);
  }
  if (seen.has(value)) throw new Error("cyclic YAML aliases are not supported");
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => normalizeYamlObject(item, seen));
  } else if (value instanceof Map) {
    const entries: Array<[string, unknown]> = [];
    for (const [key, item] of value.entries()) {
      if (typeof key !== "string") {
        throw new Error("frontmatter mapping keys must be strings");
      }
      entries.push([key, normalizeYamlObject(item, seen)]);
    }
    result = safeObjectEntries(entries);
  } else {
    result = safeObjectEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeYamlObject(item, seen),
      ]),
    );
  }
  seen.delete(value);
  return result;
}

function resolveSpecPath(value: FilePath): string {
  if (value instanceof URL) return fileURLToPath(value);
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeObjectEntries(
  entries: Iterable<readonly [string, unknown]>,
): Record<string, unknown> {
  const object = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of entries) {
    Object.defineProperty(object, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return object;
}
