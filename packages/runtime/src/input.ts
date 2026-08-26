import type { FilePath } from './storage.js';
/** Input loading, RFC 6901 traversal, and deterministic row ID handling. */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, resolve } from 'node:path';

import { fileURLToPath } from 'node:url';
import { parse as parseCsv } from 'csv-parse/sync';

import { parseDocument } from 'yaml';
import { AgentJobsError } from './errors.js';
import {
  isPreciseNumber,
  preserveYamlNumberPrecision,
} from './numbers.js';
import { parseStrictJson, readUtf8File } from './storage.js';

export type InputRecord = Record<string, unknown>;

const SAFE_ID_RE = /^[A-Z0-9][\w.-]{0,179}$/i;
/** Load object records from JSON, JSONL, CSV, YAML, or YML. */
export async function loadRecords(
  path: FilePath,
  recordsPath?: string | null,
): Promise<InputRecord[]> {
  const source = resolveInputPath(path);
  try {
    const info = await stat(source);
    if (!info.isFile())
      throw new Error('not a regular file');
  } catch {
    throw new AgentJobsError(
      'input_not_found',
      `Input data does not exist: ${source}`,
      { path: source },
    );
  }

  const suffix = extname(source).toLocaleLowerCase('en-US');
  let data: unknown;
  try {
    if (suffix === '.json') {
      data = parseStrictJson(await readUtf8File(source), { integers: 'bigint' });
    } else if (suffix === '.jsonl' || suffix === '.ndjson') {
      rejectRecordsPath(recordsPath, 'JSONL');
      data = await loadJsonl(source);
    } else if (suffix === '.csv') {
      rejectRecordsPath(recordsPath, 'CSV');
      data = await loadCsv(source);
    } else if (suffix === '.yaml' || suffix === '.yml') {
      data = parseYaml(await readUtf8File(source));
    } else {
      throw new AgentJobsError(
        'unsupported_input_format',
        `Unsupported input extension: ${suffix || '<none>'}`,
        { path: source },
      );
    }
  } catch (error) {
    if (error instanceof AgentJobsError)
      throw error;
    throw new AgentJobsError(
      'invalid_input',
      `Could not load input data: ${errorMessage(error)}`,
      { path: source },
    );
  }

  if (
    ['.json', '.yaml', '.yml'].includes(suffix)
    && recordsPath !== undefined
    && recordsPath !== null
    && recordsPath !== ''
  ) {
    data = resolveJsonPointer(data, recordsPath);
  }
  if (!Array.isArray(data)) {
    throw new AgentJobsError(
      'invalid_records',
      'Input records must be a top-level list unless RECORDS_PATH selects a list',
    );
  }

  const records: InputRecord[] = [];
  const errors: Array<{ row: number; message: string }> = [];
  for (const [index, value] of data.entries()) {
    if (isRecord(value))
      records.push(value);
    else errors.push({ row: index, message: 'record must be an object' });
  }
  if (errors.length > 0) {
    throw new AgentJobsError(
      'invalid_records',
      'One or more records are not objects',
      errors,
    );
  }
  return records;
}

/** Resolve an RFC 6901 JSON Pointer against a JSON-like value. */
export function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === '')
    return document;
  if (!pointer.startsWith('/')) {
    throw new AgentJobsError(
      'invalid_records_path',
      'RECORDS_PATH must be an RFC 6901 JSON Pointer',
    );
  }

  let current = document;
  for (const rawToken of pointer.slice(1).split('/')) {
    if (/~(?![01])/.test(rawToken)) {
      throw new AgentJobsError(
        'invalid_records_path',
        `RECORDS_PATH contains an invalid escape: ${rawToken}`,
      );
    }
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~');
    if (isRecord(current)) {
      if (!Object.hasOwn(current, token)) {
        throw pointerNotFound(
          `RECORDS_PATH component does not exist: ${token}`,
          pointer,
        );
      }
      current = current[token];
      continue;
    }
    if (Array.isArray(current)) {
      if (!/^[+-]?\d+$/.test(token)) {
        throw pointerNotFound(
          `RECORDS_PATH list component is not an index: ${token}`,
          pointer,
        );
      }
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) {
        throw pointerNotFound(
          `RECORDS_PATH index is out of range: ${token}`,
          pointer,
        );
      }
      current = current[index];
      continue;
    }
    throw pointerNotFound(
      `RECORDS_PATH traverses a scalar at: ${token}`,
      pointer,
    );
  }
  return current;
}

/** Return the exact canonical string form of an accepted row ID. */
export function canonicalizeId(value: unknown): string {
  if (typeof value === 'bigint')
    return value.toString(10);
  if (typeof value === 'string' && value.trim().length > 0)
    return value;
  throw new AgentJobsError(
    'invalid_id',
    'Row ID must be a non-empty string or integer',
  );
}

/** Map a canonical ID to a stable, traversal-safe filename stem. */
export function safeIdFilename(identifier: string): string {
  if (
    SAFE_ID_RE.test(identifier)
    && identifier !== '.'
    && identifier !== '..'
  ) {
    return identifier;
  }
  const bytes = Buffer.from(identifier, 'utf8');
  const encoded = bytes.toString('base64url');
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  return `id-${encoded.slice(0, 120)}-${digest}`;
}

async function loadJsonl(path: string): Promise<unknown[]> {
  const values: unknown[] = [];
  const lines = (await readUtf8File(path)).split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0)
      continue;
    try {
      values.push(parseStrictJson(line, { integers: 'bigint' }));
    } catch (error) {
      throw new AgentJobsError(
        'invalid_input',
        `Invalid JSONL on line ${index + 1}: ${errorMessage(error)}`,
        { path, line: index + 1 },
      );
    }
  }
  return values;
}

async function loadCsv(path: string): Promise<InputRecord[]> {
  const text = await readUtf8File(path);
  const rows = parseCsv(text, {
    bom: true,
    encoding: 'utf8',
    skip_empty_lines: true,
  }) as string[][];
  const header = rows[0];
  if (header === undefined) {
    throw new AgentJobsError('invalid_input', 'CSV input has no header row');
  }
  if (
    header.some(name => name.length === 0)
    || new Set(header).size !== header.length
  ) {
    throw new AgentJobsError(
      'invalid_input',
      'CSV header names must be non-empty and unique',
    );
  }
  return rows.slice(1).map((row, index) => {
    if (row.length !== header.length) {
      throw new AgentJobsError(
        'invalid_input',
        `CSV row ${index + 2} has ${row.length} fields; expected ${header.length}`,
        { path, line: index + 2 },
      );
    }
    return safeObjectEntries(
      header.map((name, column) => [name, row[column] ?? '']),
    );
  });
}

function parseYaml(text: string): unknown {
  const document = parseDocument(text, {
    intAsBigInt: true,
    keepSourceTokens: true,
    prettyErrors: true,
    schema: 'core',
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map(error => error.message).join('; '));
  }
  preserveYamlNumberPrecision(document);
  const value: unknown = document.toJS({ mapAsMap: true, maxAliasCount: 100 });
  return normalizeYamlValue(value);
}

function normalizeYamlValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'bigint' || isPreciseNumber(value)) {
    return value;
  }
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('non-finite YAML numbers are not supported');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`YAML contains a non-JSON value of type ${typeof value}`);
  }
  if (seen.has(value))
    throw new Error('cyclic YAML aliases are not supported');
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map(item => normalizeYamlValue(item, seen));
  } else if (value instanceof Map) {
    const entries: Array<[string, unknown]> = [];
    for (const [key, item] of value.entries()) {
      if (typeof key !== 'string')
        throw new Error('YAML mapping keys must be strings');
      entries.push([key, normalizeYamlValue(item, seen)]);
    }
    result = safeObjectEntries(entries);
  } else {
    result = safeObjectEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeYamlValue(item, seen),
      ]),
    );
  }
  seen.delete(value);
  return result;
}

function resolveInputPath(value: FilePath): string {
  if (value instanceof URL)
    return fileURLToPath(value);
  if (value === '~')
    return homedir();
  if (value.startsWith('~/'))
    return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function rejectRecordsPath(recordsPath: string | null | undefined, format: string): void {
  if (recordsPath !== undefined && recordsPath !== null && recordsPath !== '') {
    throw new AgentJobsError(
      'records_path_not_supported',
      `RECORDS_PATH is not supported for ${format} input`,
    );
  }
}

function pointerNotFound(message: string, pointer: string): AgentJobsError {
  return new AgentJobsError('records_path_not_found', message, { pointer });
}

function isRecord(value: unknown): value is InputRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeObjectEntries(entries: Iterable<readonly [string, unknown]>): InputRecord {
  const object = Object.create(null) as InputRecord;
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
