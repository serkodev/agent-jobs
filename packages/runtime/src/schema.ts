import type { BaseIssue } from 'valibot';
import * as v from 'valibot';

import { AgentJobsError } from './errors.js';
import {
  isPreciseNumber,
  preciseNumberText,
} from './numbers.js';
import { stringifyStrictJson } from './storage.js';

export const FIELD_TYPES = [
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
] as const;

export type FieldType = typeof FIELD_TYPES[number];

/** The user-facing schema DSL shared by task specs and MCP tools. */
export interface FieldSchema {
  type: FieldType | FieldType[];
  optional?: boolean;
  description?: string;
  enum?: unknown[];
  properties?: RecordSchema;
  items?: FieldSchema;
  loose?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: unknown;
  maximum?: unknown;
  exclusiveMinimum?: unknown;
  exclusiveMaximum?: unknown;
  multipleOf?: unknown;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
}

export type RecordSchema = Record<string, FieldSchema>;

export interface RecordSchemaConfig {
  loose: boolean;
  schema: RecordSchema;
}

export interface FieldValidationSchema {
  optional: boolean;
  schema: FieldSchema;
}

export type RecordValidationSchema = Record<string, FieldValidationSchema>;

export interface ValidationDiagnostic {
  path: string;
  message: string;
  validator: string;
}

interface Rational {
  numerator: bigint;
  denominator: bigint;
}

interface StandardIssue {
  message: string;
  path?: Array<{ key: PropertyKey }>;
}

interface StandardRecordSchema<T extends object> {
  '~standard': {
    version: 1;
    vendor: string;
    types: { input: T; output: T };
    validate: (value: unknown) => { value: T } | { issues: StandardIssue[] };
    jsonSchema: {
      input: () => Record<string, unknown>;
      output: () => Record<string, unknown>;
    };
  };
}

const fieldTypeSchema = v.picklist(FIELD_TYPES);
const fieldTypesSchema = v.union([
  fieldTypeSchema,
  v.pipe(
    v.array(fieldTypeSchema),
    v.minLength(1),
    v.check(
      types => new Set(types).size === types.length,
      'Field types must be unique',
    ),
  ),
]);
const finiteSchemaNumber = v.custom(
  value => typeof value === 'bigint'
    || isPreciseNumber(value)
    || (typeof value === 'number' && Number.isFinite(value)),
  'Expected a finite JSON number',
);
const positiveSchemaNumber = v.pipe(
  finiteSchemaNumber,
  v.check(isPositiveNumber, 'Expected a positive JSON number'),
);
const sizeSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const objectValueSchema = v.custom<Record<string, unknown>>(
  isRecord,
  'Expected an object',
);

const fieldSchemaParser = v.strictObject({
  type: fieldTypesSchema,
  optional: v.optional(v.boolean()),
  description: v.optional(v.string()),
  enum: v.optional(v.pipe(v.array(v.unknown()), v.minLength(1))),
  properties: v.optional(objectValueSchema),
  items: v.optional(v.union([fieldTypeSchema, objectValueSchema])),
  loose: v.optional(v.boolean()),
  minLength: v.optional(sizeSchema),
  maxLength: v.optional(sizeSchema),
  pattern: v.optional(v.string()),
  minimum: v.optional(finiteSchemaNumber),
  maximum: v.optional(finiteSchemaNumber),
  exclusiveMinimum: v.optional(finiteSchemaNumber),
  exclusiveMaximum: v.optional(finiteSchemaNumber),
  multipleOf: v.optional(positiveSchemaNumber),
  minItems: v.optional(sizeSchema),
  maxItems: v.optional(sizeSchema),
  uniqueItems: v.optional(v.boolean()),
  minProperties: v.optional(sizeSchema),
  maxProperties: v.optional(sizeSchema),
});

/** Parse and normalize a record-shaped DSL definition. */
export function parseRecordSchema(
  fields: Record<string, unknown>,
  name: string,
): { fields: RecordSchema; validation: RecordValidationSchema } {
  assertJsonCompatible(fields, name);
  const normalized = safeObject<RecordSchema>();
  const validation = safeObject<RecordValidationSchema>();

  for (const [field, definition] of Object.entries(fields)) {
    const schema = parseFieldSchema(definition, `${name}.${field}`, true);
    defineSafe(normalized, field, schema);
    defineSafe(validation, field, {
      optional: schema.optional === true,
      schema,
    });
  }
  return { fields: normalized, validation };
}

/** Compile a stored or programmatic record schema before validating values. */
export function compileRecordSchema(
  fields: Record<string, unknown>,
  name: string,
): RecordValidationSchema {
  return parseRecordSchema(fields, name).validation;
}

/** Validate one value against a field definition. */
export function fieldValidationErrors(
  value: unknown,
  definition: FieldSchema | FieldType,
): ValidationDiagnostic[] {
  const schema = parseFieldSchema(definition, 'field', true);
  return sortDiagnostics(validateField(value, schema, ''));
}

/** Validate an object directly against field schemas and record looseness. */
export function recordValidationErrors(
  instance: Record<string, unknown>,
  config: RecordSchemaConfig,
  validation: RecordValidationSchema,
): ValidationDiagnostic[] {
  const errors: ValidationDiagnostic[] = [];
  if (!config.loose) {
    for (const field of Object.keys(instance)) {
      if (!Object.hasOwn(validation, field)) {
        errors.push({
          path: `/${escapePointer(field)}`,
          message: 'undeclared field is not allowed when loose is false',
          validator: 'loose',
        });
      }
    }
  }
  validateProperties(instance, validation, '', errors);
  return sortDiagnostics(errors);
}

/**
 * Wrap the shared DSL as a Standard Schema for the MCP SDK. JSON Schema exists
 * only as the protocol advertisement generated at this boundary.
 */
export function recordSchemaToStandardSchema<T extends object>(
  fields: Record<string, unknown>,
  options: {
    loose?: boolean;
    refine?: (value: T) => ValidationDiagnostic[];
  } = {},
): StandardRecordSchema<T> {
  const parsed = parseRecordSchema(fields, 'tool.schema');
  const config: RecordSchemaConfig = {
    loose: options.loose ?? false,
    schema: parsed.fields,
  };
  const wireSchema = recordSchemaToWireSchema(config);

  return {
    '~standard': {
      version: 1,
      vendor: 'agent-jobs',
      types: undefined as unknown as { input: T; output: T },
      validate(value: unknown) {
        if (!isRecord(value)) {
          return { issues: [{ message: 'arguments must be an object' }] };
        }
        const typedValue = value as T;
        const diagnostics = recordValidationErrors(
          value,
          config,
          parsed.validation,
        );
        if (options.refine !== undefined)
          diagnostics.push(...options.refine(typedValue));
        const issues = sortDiagnostics(diagnostics).map(standardIssue);
        return issues.length > 0 ? { issues } : { value: typedValue };
      },
      jsonSchema: {
        input: () => wireSchema,
        output: () => wireSchema,
      },
    },
  };
}

function parseFieldSchema(
  definition: unknown,
  path: string,
  property: boolean,
): FieldSchema {
  const expanded = typeof definition === 'string'
    ? { type: definition }
    : definition;
  const result = v.safeParse(fieldSchemaParser, expanded, {
    abortEarly: false,
  });
  if (!result.success) {
    throw new AgentJobsError(
      'invalid_spec',
      `${path} contains an invalid field schema`,
      schemaDiagnostics(result.issues),
    );
  }

  const schema = result.output as FieldSchema;
  const types = typeSet(schema);
  if (!property && schema.optional !== undefined)
    invalidField(path, 'optional is only valid for named object fields');
  requireTypeForKeys(path, types, schema, 'string', [
    'minLength',
    'maxLength',
    'pattern',
  ]);
  requireTypeForKeys(path, types, schema, 'array', [
    'items',
    'minItems',
    'maxItems',
    'uniqueItems',
  ]);
  requireTypeForKeys(path, types, schema, 'object', [
    'properties',
    'loose',
    'minProperties',
    'maxProperties',
  ]);
  requireNumericType(path, types, schema);
  checkOrderedSizes(path, schema, 'minLength', 'maxLength');
  checkOrderedSizes(path, schema, 'minItems', 'maxItems');
  checkOrderedSizes(path, schema, 'minProperties', 'maxProperties');
  checkNumericBounds(path, schema);

  if (schema.pattern !== undefined) {
    try {
      compilePattern(schema.pattern);
    } catch (error) {
      invalidField(path, `pattern is not a valid regular expression: ${errorMessage(error)}`);
    }
  }

  const normalized = safeObject<FieldSchema>();
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties') {
      defineSafe(
        normalized,
        key,
        parseRecordSchema(value as Record<string, unknown>, `${path}.properties`).fields,
      );
    } else if (key === 'items') {
      defineSafe(
        normalized,
        key,
        parseFieldSchema(value, `${path}.items`, false),
      );
    } else {
      defineSafe(normalized, key, value);
    }
  }

  if (normalized.enum !== undefined) {
    const fingerprints = normalized.enum.map(item => exactFingerprint(item, true));
    if (new Set(fingerprints).size !== fingerprints.length)
      invalidField(path, 'enum values must be unique');
    for (const value of normalized.enum) {
      if (!matchesAnyType(value, types, true)) {
        invalidField(
          path,
          `enum value ${stringifyStrictJson(value)} does not match the field type`,
        );
      }
    }
  }
  return normalized;
}

function validateField(
  value: unknown,
  schema: FieldSchema,
  path: string,
): ValidationDiagnostic[] {
  const errors: ValidationDiagnostic[] = [];
  const types = typeSet(schema);
  if (!matchesAnyType(value, types, false)) {
    errors.push({
      path,
      message: `expected ${Array.from(types).join(' or ')}`,
      validator: 'type',
    });
    return errors;
  }

  if (
    schema.enum !== undefined
    && !schema.enum.some(item => exactEqual(item, value))
  ) {
    errors.push({ path, message: 'value is not in enum', validator: 'enum' });
  }
  if (typeof value === 'string')
    validateString(value, schema, path, errors);
  if (numericRational(value) !== null)
    validateNumber(value, schema, path, errors);
  if (Array.isArray(value))
    validateArray(value, schema, path, errors);
  if (isJsonObject(value))
    validateObject(value, schema, path, errors);
  return errors;
}

function validateString(
  value: string,
  schema: FieldSchema,
  path: string,
  errors: ValidationDiagnostic[],
): void {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push({
      path,
      message: `must contain at least ${schema.minLength} characters`,
      validator: 'minLength',
    });
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    errors.push({
      path,
      message: `must contain at most ${schema.maxLength} characters`,
      validator: 'maxLength',
    });
  }
  if (schema.pattern !== undefined && !compilePattern(schema.pattern).test(value)) {
    errors.push({ path, message: 'must match pattern', validator: 'pattern' });
  }
}

function validateNumber(
  value: unknown,
  schema: FieldSchema,
  path: string,
  errors: ValidationDiagnostic[],
): void {
  const numeric = numericRational(value);
  if (numeric === null)
    return;
  checkNumericConstraint('minimum', comparison => comparison >= 0);
  checkNumericConstraint('maximum', comparison => comparison <= 0);
  checkNumericConstraint('exclusiveMinimum', comparison => comparison > 0);
  checkNumericConstraint('exclusiveMaximum', comparison => comparison < 0);
  if (schema.multipleOf !== undefined) {
    const divisor = numericRational(schema.multipleOf, true)!;
    const numerator = numeric.numerator * divisor.denominator;
    const denominator = numeric.denominator * divisor.numerator;
    if (denominator === 0n || numerator % denominator !== 0n) {
      errors.push({ path, message: 'must be a multiple', validator: 'multipleOf' });
    }
  }

  function checkNumericConstraint(
    key: 'minimum' | 'maximum' | 'exclusiveMinimum' | 'exclusiveMaximum',
    accepted: (comparison: number) => boolean,
  ): void {
    const boundary = schema[key];
    if (boundary === undefined)
      return;
    if (!accepted(compareRationals(numeric!, numericRational(boundary, true)!))) {
      errors.push({ path, message: `violates ${key}`, validator: key });
    }
  }
}

function validateArray(
  value: unknown[],
  schema: FieldSchema,
  path: string,
  errors: ValidationDiagnostic[],
): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push({ path, message: 'contains too few items', validator: 'minItems' });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    errors.push({ path, message: 'contains too many items', validator: 'maxItems' });
  }
  if (schema.uniqueItems === true) {
    const fingerprints = value.map(item => exactFingerprint(item));
    if (new Set(fingerprints).size !== fingerprints.length) {
      errors.push({ path, message: 'items must be unique', validator: 'uniqueItems' });
    }
  }
  if (schema.items !== undefined) {
    value.forEach((item, index) => {
      errors.push(...validateField(item, schema.items!, `${path}/${index}`));
    });
  }
}

function validateObject(
  value: Record<string, unknown>,
  schema: FieldSchema,
  path: string,
  errors: ValidationDiagnostic[],
): void {
  const keys = Object.keys(value);
  if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
    errors.push({ path, message: 'contains too few fields', validator: 'minProperties' });
  }
  if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
    errors.push({ path, message: 'contains too many fields', validator: 'maxProperties' });
  }

  const fields = schema.properties ?? safeObject<RecordSchema>();
  if (schema.loose !== true) {
    for (const field of keys) {
      if (!Object.hasOwn(fields, field)) {
        errors.push({
          path: `${path}/${escapePointer(field)}`,
          message: 'undeclared field is not allowed when loose is false',
          validator: 'loose',
        });
      }
    }
  }
  const validation = safeObject<RecordValidationSchema>();
  for (const [field, fieldSchema] of Object.entries(fields)) {
    defineSafe(validation, field, {
      optional: fieldSchema.optional === true,
      schema: fieldSchema,
    });
  }
  validateProperties(value, validation, path, errors);
}

function validateProperties(
  instance: Record<string, unknown>,
  validation: RecordValidationSchema,
  parentPath: string,
  errors: ValidationDiagnostic[],
): void {
  for (const [field, fieldValidation] of Object.entries(validation)) {
    const path = `${parentPath}/${escapePointer(field)}`;
    if (!Object.hasOwn(instance, field)) {
      if (!fieldValidation.optional) {
        errors.push({
          path,
          message: `${field} is required`,
          validator: 'required',
        });
      }
      continue;
    }
    errors.push(...validateField(instance[field], fieldValidation.schema, path));
  }
}

function requireTypeForKeys(
  path: string,
  types: Set<FieldType>,
  schema: FieldSchema,
  type: FieldType,
  keys: Array<keyof FieldSchema>,
): void {
  if (types.has(type))
    return;
  const used = keys.find(key => schema[key] !== undefined);
  if (used !== undefined)
    invalidField(path, `${String(used)} requires type ${type}`);
}

function requireNumericType(
  path: string,
  types: Set<FieldType>,
  schema: FieldSchema,
): void {
  if (types.has('integer') || types.has('number'))
    return;
  const keys = [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
  ] as const;
  const used = keys.find(key => schema[key] !== undefined);
  if (used !== undefined)
    invalidField(path, `${used} requires type integer or number`);
}

function checkOrderedSizes(
  path: string,
  schema: FieldSchema,
  minimum: 'minLength' | 'minItems' | 'minProperties',
  maximum: 'maxLength' | 'maxItems' | 'maxProperties',
): void {
  const low = schema[minimum];
  const high = schema[maximum];
  if (low !== undefined && high !== undefined && low > high)
    invalidField(path, `${minimum} cannot exceed ${maximum}`);
}

function checkNumericBounds(path: string, schema: FieldSchema): void {
  const lower = schema.minimum ?? schema.exclusiveMinimum;
  const upper = schema.maximum ?? schema.exclusiveMaximum;
  if (
    lower !== undefined
    && upper !== undefined
    && compareRationals(
      numericRational(lower, true)!,
      numericRational(upper, true)!,
    ) > 0
  ) {
    invalidField(path, 'minimum cannot exceed maximum');
  }
}

function typeSet(schema: FieldSchema): Set<FieldType> {
  return new Set(Array.isArray(schema.type) ? schema.type : [schema.type]);
}

function matchesAnyType(
  value: unknown,
  types: Set<FieldType>,
  schemaNumber: boolean,
): boolean {
  for (const type of types) {
    if (matchesType(value, type, schemaNumber))
      return true;
  }
  return false;
}

function matchesType(
  value: unknown,
  type: FieldType,
  schemaNumber: boolean,
): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isJsonObject(value);
    case 'number':
      return numericRational(value, schemaNumber) !== null;
    case 'integer': {
      const numeric = numericRational(value, schemaNumber);
      return numeric !== null && numeric.numerator % numeric.denominator === 0n;
    }
  }
}

function numericRational(value: unknown, schema = false): Rational | null {
  if (typeof value === 'bigint')
    return { numerator: value, denominator: 1n };
  if (isPreciseNumber(value))
    return rationalFromDecimal(preciseNumberText(value));
  if (typeof value !== 'number' || !Number.isFinite(value))
    return null;
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new AgentJobsError(
      schema ? 'inexact_numeric_schema' : 'inexact_number',
      schema
        ? 'Unsafe JavaScript integer in a field schema is ambiguous; use bigint'
        : 'Unsafe JavaScript integer cannot be validated exactly; use bigint',
      { value: value.toString() },
    );
  }
  return rationalFromDecimal(value.toString());
}

function isPositiveNumber(value: unknown): boolean {
  const numeric = numericRational(value, true);
  return numeric !== null && numeric.numerator > 0n;
}

function rationalFromDecimal(value: string): Rational {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
  if (match === null)
    throw new Error(`Not a finite decimal number: ${value}`);
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? '0');
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100_000)
    throw new Error(`Decimal exponent is too large: ${value}`);
  let numerator = BigInt(`${match[2]}${fraction}` || '0');
  if (match[1] === '-')
    numerator = -numerator;
  const scale = fraction.length - exponent;
  let denominator = 1n;
  if (scale <= 0)
    numerator *= 10n ** BigInt(-scale);
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

function compareRationals(left: Rational, right: Rational): number {
  const comparison
    = left.numerator * right.denominator - right.numerator * left.denominator;
  return comparison < 0n ? -1 : comparison > 0n ? 1 : 0;
}

function exactEqual(left: unknown, right: unknown): boolean {
  return exactFingerprint(left) === exactFingerprint(right);
}

function exactFingerprint(
  value: unknown,
  schemaNumber = false,
  seen = new WeakSet<object>(),
): string {
  const numeric = numericRational(value, schemaNumber);
  if (numeric !== null) {
    const reduced = reduceRational(numeric);
    return `number:${reduced.numerator}/${reduced.denominator}`;
  }
  if (value === null)
    return 'null';
  if (typeof value === 'string')
    return `string:${JSON.stringify(value)}`;
  if (typeof value === 'boolean')
    return `boolean:${value ? '1' : '0'}`;
  if (typeof value !== 'object')
    return `${typeof value}:${String(value)}`;
  if (seen.has(value))
    throw new Error('cyclic values cannot be compared exactly');
  seen.add(value);
  let fingerprint: string;
  if (Array.isArray(value)) {
    fingerprint = `array:[${value
      .map(item => exactFingerprint(item, schemaNumber, seen))
      .join(',')}]`;
  } else {
    const entries = Object.keys(value)
      .sort(compareCodePoints)
      .map(key => `${JSON.stringify(key)}:${exactFingerprint(
        (value as Record<string, unknown>)[key],
        schemaNumber,
        seen,
      )}`);
    fingerprint = `object:{${entries.join(',')}}`;
  }
  seen.delete(value);
  return fingerprint;
}

function recordSchemaToWireSchema(
  config: RecordSchemaConfig,
): Record<string, unknown> {
  const properties = safeObject<Record<string, unknown>>();
  const required: string[] = [];
  for (const [field, schema] of Object.entries(config.schema)) {
    defineSafe(properties, field, fieldSchemaToWireSchema(schema));
    if (schema.optional !== true)
      required.push(field);
  }
  return {
    type: 'object',
    additionalProperties: config.loose,
    ...(required.length === 0 ? {} : { required }),
    properties,
  };
}

function fieldSchemaToWireSchema(schema: FieldSchema): Record<string, unknown> {
  const result = safeObject<Record<string, unknown>>();
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'optional' || key === 'loose')
      continue;
    if (key === 'properties') {
      const nested = recordSchemaToWireSchema({
        loose: schema.loose === true,
        schema: value as RecordSchema,
      });
      defineSafe(result, 'properties', nested.properties);
      if (nested.required !== undefined)
        defineSafe(result, 'required', nested.required);
      defineSafe(result, 'additionalProperties', nested.additionalProperties);
      continue;
    }
    if (key === 'items') {
      defineSafe(result, key, fieldSchemaToWireSchema(value as FieldSchema));
      continue;
    }
    defineSafe(result, key, wireValue(value));
  }
  if (typeSet(schema).has('object') && schema.properties === undefined)
    defineSafe(result, 'additionalProperties', schema.loose === true);
  return result;
}

function wireValue(value: unknown): unknown {
  if (typeof value === 'bigint' || isPreciseNumber(value)) {
    throw new TypeError(
      'MCP protocol schemas cannot safely advertise arbitrary-precision numeric constraints',
    );
  }
  if (Array.isArray(value))
    return value.map(wireValue);
  if (isRecord(value)) {
    const normalized = safeObject<Record<string, unknown>>();
    for (const [key, item] of Object.entries(value))
      defineSafe(normalized, key, wireValue(item));
    return normalized;
  }
  return value;
}

function standardIssue(diagnostic: ValidationDiagnostic): StandardIssue {
  const keys = pointerKeys(diagnostic.path);
  return {
    message: diagnostic.message,
    ...(keys.length === 0 ? {} : { path: keys.map(key => ({ key })) }),
  };
}

function pointerKeys(pointer: string): PropertyKey[] {
  if (pointer === '')
    return [];
  return pointer.slice(1).split('/').map(token =>
    token.replaceAll('~1', '/').replaceAll('~0', '~'),
  );
}

function schemaDiagnostics(
  issues: readonly BaseIssue<unknown>[],
): ValidationDiagnostic[] {
  return issues.map(issue => ({
    path: issue.path === undefined
      ? ''
      : `/${issue.path.map(item => escapePointer(String(item.key))).join('/')}`,
    message: issue.message,
    validator: issue.type,
  }));
}

function assertJsonCompatible(value: unknown, path: string): void {
  try {
    stringifyStrictJson(value);
  } catch (error) {
    throw new AgentJobsError(
      'invalid_spec',
      `${path} must contain only JSON-compatible values: ${errorMessage(error)}`,
    );
  }
}

function invalidField(path: string, message: string): never {
  throw new AgentJobsError('invalid_spec', `${path}: ${message}`);
}

function sortDiagnostics(
  diagnostics: ValidationDiagnostic[],
): ValidationDiagnostic[] {
  return diagnostics.sort((left, right) =>
    left.path === right.path
      ? left.validator.localeCompare(right.validator, 'en')
      : left.path.localeCompare(right.path, 'en'),
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !isPreciseNumber(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compilePattern(pattern: string): RegExp {
  return new RegExp(pattern, 'u');
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, character => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, character => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0)
      return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function defineSafe<T extends object>(
  object: T,
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

function safeObject<T extends object>(): T {
  return Object.create(null) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
