import type { FieldSchema, RecordSchema } from '../src/schema.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';

import {
  fieldValidationErrors,
  recordValidationErrors,
} from '../src/schema.js';
import { loadSpec } from '../src/spec.js';
import { parseStrictJson, stringifyStrictJson } from '../src/storage.js';

const roots: string[] = [];

const defaultInput: RecordSchema = {
  id: { type: ['string', 'integer'] },
  title: { type: 'string', minLength: 1 },
  optional: { type: 'string', optional: true },
};
const defaultOutput: RecordSchema = {
  summary: { type: 'string', minLength: 1 },
  vote: { type: 'string', enum: ['accept', 'reject'] },
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { force: true, recursive: true })),
  );
});

async function writeSpec(options: {
  name?: string;
  omitName?: boolean;
  fileName?: string;
  body?: string;
  inputFields?: Record<string, unknown>;
  inputLoose?: boolean;
  outputFields?: Record<string, unknown>;
  outputLoose?: boolean;
  extra?: Record<string, unknown>;
} = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'batch-spec-test-'));
  roots.push(root);
  const path = join(root, options.fileName ?? 'task.md');
  const metadata = {
    ...(options.omitName ? {} : { name: options.name ?? 'review' }),
    input: {
      ...(options.inputLoose === undefined ? {} : { loose: options.inputLoose }),
      schema: options.inputFields ?? defaultInput,
    },
    output: {
      ...(options.outputLoose === undefined ? {} : { loose: options.outputLoose }),
      schema: options.outputFields ?? defaultOutput,
    },
    ...options.extra,
  };
  await writeFile(
    path,
    `---\n${stringifyYaml(metadata).trimEnd()}\n---\n\n${options.body ?? 'Review exactly one record.'}\n`,
    'utf8',
  );
  return path;
}

describe('task specification loading', () => {
  it('defaults omitted name and version from the spec filename', async () => {
    const path = await writeSpec({
      fileName: 'summarize-article.md',
      omitName: true,
    });
    const spec = await loadSpec(path);

    expect(spec.name).toBe('summarize-article');
    expect(spec.version).toBe('1');
    expect(spec.workerPayload()).toMatchObject({
      name: 'summarize-article',
      version: '1',
    });
  });

  it('prefers an explicit valid name over the filename', async () => {
    const spec = await loadSpec(await writeSpec({
      fileName: '.md',
      name: 'explicit-name',
    }));
    expect(spec.name).toBe('explicit-name');

    await expect(loadSpec(await writeSpec({
      name: '   ',
    }))).rejects.toMatchObject({ code: 'invalid_spec' });
  });

  it('removes only the final extension when deriving name', async () => {
    const spec = await loadSpec(await writeSpec({
      fileName: 'review.task.md',
      omitName: true,
    }));
    expect(spec.name).toBe('review.task');
  });

  it('rejects a missing name when the filename cannot provide one', async () => {
    await expect(loadSpec(await writeSpec({
      fileName: '.md',
      omitName: true,
    }))).rejects.toMatchObject({
      code: 'invalid_spec',
      message: 'Task spec name could not be derived from its filename',
    });
  });

  it('parses frontmatter, defaults, body, and worker payload', async () => {
    const path = await writeSpec({
      body: '# Instructions\n\nReturn an answer in Traditional Chinese.',
      extra: {
        version: 2,
        description: 'A focused review.',
        model: 'gpt-5.6-sol',
        reasoning_effort: 'high',
      },
    });
    const spec = await loadSpec(path);
    expect(spec).toMatchObject({
      path,
      name: 'review',
      version: '2',
      description: 'A focused review.',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    });
    expect(spec.instructions).toContain('Traditional Chinese');
    expect(spec.input).toEqual({ loose: false, schema: defaultInput });
    expect(spec.inputValidation).toMatchObject({
      id: { optional: false },
      title: { optional: false },
      optional: { optional: true },
    });
    expect(spec.workerPayload()).toEqual({
      name: 'review',
      version: '2',
      description: 'A focused review.',
      instructions: spec.instructions,
      output: { loose: false, schema: defaultOutput },
    });
  });

  it('supports nested defaults with top-level model precedence', async () => {
    const nested = await loadSpec(
      await writeSpec({
        extra: { defaults: { model: 'small', reasoning_effort: 'low' } },
      }),
    );
    expect(nested.model).toBe('small');
    expect(nested.reasoningEffort).toBe('low');

    const overridden = await loadSpec(
      await writeSpec({
        extra: {
          defaults: { model: 'small', reasoning_effort: 'low' },
          model: 'strong',
        },
      }),
    );
    expect(overridden.model).toBe('strong');
    expect(overridden.reasoningEffort).toBe('low');

    const cleared = await loadSpec(
      await writeSpec({
        extra: { defaults: { model: 'small' }, model: null },
      }),
    );
    expect(cleared.model).toBeNull();
  });

  it('defaults an omitted input to a fully loose record', async () => {
    const parsed = await loadSpec(await rawSpec(`---
name: prompt-validated-input
output:
  schema: {}
---
Validate the input in the task instructions.
`));

    expect(parsed.input).toEqual({ loose: true, schema: {} });
    expect(parsed.inputValidation).toEqual({});
  });

  it('preserves large YAML integers and arbitrary-precision decimal bounds', async () => {
    const path = await rawSpec(`---
name: precise-schema
version: 9223372036854775807
input:
  schema:
    score:
      type: number
      minimum: 0.100000000000000000001
output:
  schema: {}
---
Validate the score.
`);
    const spec = await loadSpec(path);
    const score = spec.inputValidation.score!.schema;
    expect(spec.version).toBe('9223372036854775807');
    expect(stringifyStrictJson(score.minimum)).toBe('0.100000000000000000001');
    expect(recordValidationErrors(
      { score: parseStrictJson('0.100000000000000000000') },
      spec.input,
      spec.inputValidation,
    )).toEqual([
      expect.objectContaining({ path: '/score', validator: 'minimum' }),
    ]);
  });

  it('rejects malformed frontmatter and an empty instruction body', async () => {
    const cases = [
      await rawSpec('# Just prose\n'),
      await rawSpec('---\nname: broken\n'),
      await rawSpec('---\n- not\n- an-object\n---\nTask.\n'),
      await rawSpec('---\nname: [unterminated\n---\nTask.\n'),
      await writeSpec({ body: '   ' }),
    ];
    for (const path of cases)
      await expect(loadSpec(path)).rejects.toMatchObject({ code: 'invalid_spec' });
  });

  it('rejects missing roots, null versions, and unknown config keys', async () => {
    await expect(loadSpec(await rawSpec(
      '---\nname: incomplete\ninput:\n  schema: {}\n---\nTask.\n',
    ))).rejects.toMatchObject({
      code: 'invalid_spec',
      details: { missing: ['output'] },
    });
    await expect(loadSpec(await writeSpec({
      extra: { version: null },
    }))).rejects.toMatchObject({ code: 'invalid_spec' });
    await expect(loadSpec(await writeSpec({
      extra: { retired: true },
    }))).rejects.toMatchObject({ code: 'invalid_spec' });
    await expect(loadSpec(await writeSpec({
      extra: { input: { schema: defaultInput, retired: true } },
    }))).rejects.toMatchObject({ code: 'invalid_spec' });
  });

  it('defaults loose to false and accepts explicit loose records', async () => {
    const parsed = await loadSpec(await writeSpec({
      inputLoose: true,
      outputLoose: true,
    }));
    expect(parsed.input).toEqual({ loose: true, schema: defaultInput });
    expect(parsed.output).toEqual({ loose: true, schema: defaultOutput });
    expect(recordValidationErrors(
      { extra: true },
      parsed.input,
      parsed.inputValidation,
    )).toEqual([
      expect.objectContaining({ path: '/id', validator: 'required' }),
      expect.objectContaining({ path: '/title', validator: 'required' }),
    ]);

    await expect(loadSpec(await writeSpec({
      extra: {
        input: { loose: 'yes', schema: defaultInput },
      },
    }))).rejects.toMatchObject({ code: 'invalid_spec' });
    await expect(loadSpec(await rawSpec(`---
name: missing-schema
input: {}
output:
  schema: {}
---
Task.
`))).rejects.toMatchObject({ code: 'invalid_spec' });
  });

  it('normalizes scalar type shorthand for fields, properties, and items', async () => {
    const spec = await loadSpec(await rawSpec(`---
name: shorthand
input:
  schema:
    id: string
    profile:
      type: object
      properties:
        name: string
    scores:
      type: array
      items: integer
output:
  schema:
    summary: string
---
Use shorthand.
`));

    expect(spec.input.schema).toEqual({
      id: { type: 'string' },
      profile: {
        type: 'object',
        properties: { name: { type: 'string' } },
      },
      scores: {
        type: 'array',
        items: { type: 'integer' },
      },
    });
    expect(spec.output.schema).toEqual({
      summary: { type: 'string' },
    });
  });

  it('rejects unknown shorthand types and incompatible DSL keys', async () => {
    const invalidFields: Array<Record<string, unknown>> = [
      { title: 'not-a-type' },
      { title: { optional: true } },
      { title: { type: 'not-a-type' } },
      { title: { type: 'string', required: true } },
      { title: { type: 'string', retired: true } },
      { title: { type: 'string', minimum: 1 } },
      { score: { type: 'number', multipleOf: 0 } },
      { items: { type: 'array', items: { type: 'string', optional: true } } },
      { value: { type: ['string', 'string'] } },
    ];
    for (const inputFields of invalidFields) {
      await expect(
        loadSpec(await writeSpec({ inputFields })),
      ).rejects.toMatchObject({ code: 'invalid_spec' });
    }
  });

  it('expands nested fields and applies loose consistently at every object level', async () => {
    const strict = await loadSpec(await writeSpec({
      inputFields: {
        profile: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            nickname: { type: 'string', optional: true },
          },
        },
      },
    }));
    expect(recordValidationErrors(
      {},
      strict.input,
      strict.inputValidation,
    )).toEqual([
      expect.objectContaining({ path: '/profile', validator: 'required' }),
    ]);
    expect(recordValidationErrors(
      { profile: {} },
      strict.input,
      strict.inputValidation,
    )).toEqual([
      expect.objectContaining({ path: '/profile/name', validator: 'required' }),
    ]);
    expect(recordValidationErrors(
      { profile: { name: 'Ada', unknown: true } },
      strict.input,
      strict.inputValidation,
    )).toEqual([
      expect.objectContaining({ path: '/profile/unknown', validator: 'loose' }),
    ]);

    const loose = await loadSpec(await writeSpec({
      inputFields: {
        profile: { type: 'object', loose: true },
      },
    }));
    expect(recordValidationErrors(
      { profile: { any: 'JSON value' } },
      loose.input,
      loose.inputValidation,
    )).toEqual([]);
  });

  it('preserves literal __proto__ field names without prototype mutation', async () => {
    const path = await rawSpec(`---
name: safe-keys
input:
  schema:
    __proto__:
      type: string
    constructor:
      type: string
      optional: true
output:
  schema: {}
---
Task.
`);
    const parsed = await loadSpec(path);
    expect(Object.hasOwn(parsed.inputValidation, '__proto__')).toBe(true);
    expect(Object.hasOwn(parsed.inputValidation, 'constructor')).toBe(true);
    expect(Object.getPrototypeOf(parsed.inputValidation)).toBeNull();
    const row = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(row, '__proto__', {
      enumerable: true,
      value: 'literal',
    });
    expect(recordValidationErrors(
      row,
      parsed.input,
      parsed.inputValidation,
    )).toEqual([]);
  });
});

describe('field schema DSL validation', () => {
  it.each([
    ['string', 'text'],
    ['boolean', true],
    ['null', null],
    ['array', []],
    ['object', {}],
    ['integer', 42],
    ['integer', 9223372036854775807n],
    ['number', parseStrictJson('1.25')],
    ['number', 9223372036854775807n],
  ] as const)('supports %s values including exact integer/float representations', (type, value) => {
    expect(fieldValidationErrors(value, {
      type,
      ...(type === 'object' ? { loose: true } : {}),
    })).toEqual([]);
  });

  it('keeps integer, number, null, and union semantics explicit', () => {
    expect(fieldValidationErrors(1.5, { type: 'integer' })).toEqual([
      expect.objectContaining({ validator: 'type' }),
    ]);
    expect(fieldValidationErrors(1, { type: 'number' })).toEqual([]);
    expect(fieldValidationErrors(null, {
      type: ['string', 'null'],
      minLength: 1,
    })).toEqual([]);
    expect(fieldValidationErrors('', {
      type: ['string', 'null'],
      minLength: 1,
    })).toEqual([expect.objectContaining({ validator: 'minLength' })]);
  });

  it('validates strings, arrays, and nested objects with deterministic paths', () => {
    const schema: FieldSchema = {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          minItems: 2,
          uniqueItems: true,
          items: { type: 'string', minLength: 2 },
        },
      },
    };
    expect(fieldValidationErrors({ tags: ['x', 'x'] }, schema)).toEqual([
      expect.objectContaining({ path: '/tags', validator: 'uniqueItems' }),
      expect.objectContaining({ path: '/tags/0', validator: 'minLength' }),
      expect.objectContaining({ path: '/tags/1', validator: 'minLength' }),
    ]);
    expect(fieldValidationErrors({ tags: [] }, schema)).toEqual([
      expect.objectContaining({ path: '/tags', validator: 'minItems' }),
    ]);
  });

  it('compares bigint enum and numeric constraints without Number rounding', () => {
    const schema: FieldSchema = {
      type: 'integer',
      enum: [9007199254740993n, 9007199254740994n],
      minimum: 9007199254740993n,
      maximum: 9007199254740994n,
      multipleOf: 2n,
    };
    expect(fieldValidationErrors(9007199254740994n, schema)).toEqual([]);
    expect(fieldValidationErrors(9007199254740992n, schema)).toEqual([
      expect.objectContaining({ validator: 'enum' }),
      expect.objectContaining({ validator: 'minimum' }),
    ]);
    expect(fieldValidationErrors(9007199254740993n, schema)).toEqual([
      expect.objectContaining({ validator: 'multipleOf' }),
    ]);
  });

  it('validates arbitrary-precision decimal boundaries and multiples', () => {
    const below = parseStrictJson('0.100000000000000000000');
    const exact = parseStrictJson('0.100000000000000000001');
    const above = parseStrictJson('0.100000000000000000002');
    const schema: FieldSchema = {
      type: 'number',
      minimum: exact,
      maximum: exact,
      multipleOf: exact,
    };
    expect(fieldValidationErrors(exact, schema)).toEqual([]);
    expect(fieldValidationErrors(below, schema)).toEqual([
      expect.objectContaining({ validator: 'minimum' }),
      expect.objectContaining({ validator: 'multipleOf' }),
    ]);
    expect(fieldValidationErrors(above, schema)).toEqual([
      expect.objectContaining({ validator: 'maximum' }),
      expect.objectContaining({ validator: 'multipleOf' }),
    ]);
    expect(fieldValidationErrors(parseStrictJson('9007199254740993.0'), {
      type: 'integer',
    })).toEqual([]);
  });

  it('uses exact nested equality for enum and uniqueItems', () => {
    expect(fieldValidationErrors(
      { result: 9007199254740993n },
      {
        type: 'object',
        loose: true,
        enum: [{ result: 9007199254740993n }],
      },
    )).toEqual([]);
    expect(fieldValidationErrors(
      [9007199254740992n, 9007199254740993n],
      { type: 'array', uniqueItems: true },
    )).toEqual([]);
    expect(fieldValidationErrors(
      [9007199254740993n, 9007199254740993n],
      { type: 'array', uniqueItems: true },
    )).toEqual([expect.objectContaining({ validator: 'uniqueItems' })]);
  });

  it('rejects already-rounded unsafe JavaScript numbers', () => {
    expect(() => fieldValidationErrors(9007199254740992, {
      type: 'integer',
    })).toThrowError(expect.objectContaining({ code: 'inexact_number' }));
    expect(() => fieldValidationErrors(1n, {
      type: 'integer',
      enum: [9007199254740992],
    })).toThrowError(expect.objectContaining({ code: 'inexact_numeric_schema' }));
  });
});

async function rawSpec(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'batch-spec-raw-test-'));
  roots.push(root);
  const path = join(root, 'task.md');
  await writeFile(path, content, 'utf8');
  return path;
}
