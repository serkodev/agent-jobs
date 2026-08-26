import type { JsonSchema } from '../src/spec.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { stringify as stringifyYaml } from 'yaml';
import {

  loadSpec,
  validationErrors,
} from '../src/spec.js';
import { parseStrictJson, stringifyStrictJson } from '../src/storage.js';

const roots: string[] = [];

const defaultInput: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: ['string', 'integer'] },
    title: { type: 'string', minLength: 1 },
    optional: { type: 'string' },
  },
  required: ['id', 'title'],
  additionalProperties: false,
};
const defaultOutput: JsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', minLength: 1 },
    vote: { type: 'string', enum: ['accept', 'reject'] },
  },
  required: ['summary', 'vote'],
  additionalProperties: false,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

async function writeSpec(options: {
  name?: string;
  body?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  extra?: Record<string, unknown>;
} = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'batch-spec-test-'));
  roots.push(root);
  const path = join(root, 'task.md');
  const metadata = {
    name: options.name ?? 'review',
    input_schema: options.inputSchema ?? defaultInput,
    output_schema: options.outputSchema ?? defaultOutput,
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
    expect(spec.inputSchema.required).toEqual(['id', 'title']);
    expect(spec.workerPayload()).toEqual({
      name: 'review',
      version: '2',
      description: 'A focused review.',
      instructions: spec.instructions,
      output_schema: defaultOutput,
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
      await writeSpec({ extra: { defaults: { model: 'small' }, model: null } }),
    );
    expect(cleared.model).toBeNull();
  });

  it('preserves large YAML integer metadata exactly', async () => {
    const spec = await loadSpec(await writeSpec({ extra: { version: 9223372036854775807n } }));
    expect(spec.version).toBe('9223372036854775807');
  });

  it('preserves arbitrary-precision YAML schema numbers exactly', async () => {
    const path = await rawSpec(`---
name: precise-schema
input_schema:
  type: object
  properties:
    score:
      type: number
      minimum: 0.100000000000000000001
  required: [score]
output_schema:
  type: object
  properties: {}
---
Validate the score.
`);
    const spec = await loadSpec(path);
    const score = (spec.inputSchema.properties as Record<string, JsonSchema>)
      .score!;
    expect(stringifyStrictJson(score.minimum)).toBe('0.100000000000000000001');
    expect(
      validationErrors(
        { score: parseStrictJson('0.100000000000000000000') },
        spec.inputSchema,
      ),
    ).toEqual([expect.objectContaining({ path: '/score', validator: 'minimum' })]);
  });

  it('rejects missing, unclosed, non-object, and empty frontmatter/body', async () => {
    const missing = await rawSpec('# Just prose\n');
    await expect(loadSpec(missing)).rejects.toMatchObject({ code: 'invalid_spec' });
    const unclosed = await rawSpec('---\nname: broken\n');
    await expect(loadSpec(unclosed)).rejects.toMatchObject({ code: 'invalid_spec' });
    const scalar = await rawSpec('---\n- not\n- an-object\n---\nTask.\n');
    await expect(loadSpec(scalar)).rejects.toMatchObject({ code: 'invalid_spec' });
    const emptyBody = await writeSpec({ body: '   ' });
    await expect(loadSpec(emptyBody)).rejects.toMatchObject({ code: 'invalid_spec' });
    const invalidYaml = await rawSpec('---\nname: [unterminated\n---\nTask.\n');
    await expect(loadSpec(invalidYaml)).rejects.toMatchObject({ code: 'invalid_spec' });
  });

  it('rejects an explicitly null version', async () => {
    await expect(loadSpec(await writeSpec({ extra: { version: null } }))).rejects.toMatchObject({
      code: 'invalid_spec',
    });
  });

  it('reports missing required root keys deterministically', async () => {
    const path = await rawSpec(
      '---\nname: incomplete\ninput_schema:\n  type: object\n---\nTask.\n',
    );
    await expect(loadSpec(path)).rejects.toMatchObject({
      code: 'invalid_spec',
      details: { missing: ['output_schema'] },
    });
  });

  it.each(['input_schema', 'output_schema'])(
    'rejects an invalid %s JSON Schema',
    async (schemaKey) => {
      const metadata: Record<string, unknown> = {
        name: 'invalid',
        input_schema: defaultInput,
        output_schema: defaultOutput,
      };
      metadata[schemaKey] = { type: 'definitely-not-a-json-schema-type' };
      const path = await rawSpec(
        `---\n${stringifyYaml(metadata).trimEnd()}\n---\nTask.\n`,
      );
      await expect(loadSpec(path)).rejects.toMatchObject({ code: 'invalid_spec' });
    },
  );

  it('requires v1 object roots and input properties', async () => {
    await expect(
      loadSpec(await writeSpec({ inputSchema: { type: 'array' } })),
    ).rejects.toMatchObject({ code: 'invalid_spec' });
    await expect(
      loadSpec(await writeSpec({ inputSchema: { type: 'object' } })),
    ).rejects.toMatchObject({ code: 'invalid_spec' });
  });

  it('rejects unresolved local and external references before row validation', async () => {
    for (const reference of ['#/missing', 'https://example.invalid/schema.json']) {
      await expect(
        loadSpec(
          await writeSpec({
            outputSchema: { type: 'object', $ref: reference },
          }),
        ),
      ).rejects.toMatchObject({
        code: 'invalid_schema_reference',
        details: { schema: 'output_schema' },
      });
    }
  });

  it('accepts resolvable local references in the same schema', async () => {
    const schema = {
      type: 'object',
      $defs: {
        result: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
      $ref: '#/$defs/result',
    } satisfies JsonSchema;
    const parsed = await loadSpec(await writeSpec({ outputSchema: schema }));
    expect(parsed.outputSchema.$ref).toBe('#/$defs/result');
    expect(validationErrors({ value: 'ok' }, parsed.outputSchema)).toEqual([]);
  });

  it('preserves literal __proto__ and const property names in YAML schemas', async () => {
    const path = await rawSpec(`---
name: safe-keys
input_schema:
  type: object
  additionalProperties: false
  required:
    - __proto__
  properties:
    __proto__:
      type: string
    const:
      type: string
output_schema:
  type: object
  properties: {}
---
Task.
`);
    const parsed = await loadSpec(path);
    const properties = parsed.inputSchema.properties as Record<string, unknown>;
    expect(Object.hasOwn(properties, '__proto__')).toBe(true);
    expect(Object.hasOwn(properties, 'const')).toBe(true);
    expect(properties.injected).toBeUndefined();
    expect(Object.getPrototypeOf(properties)).toBeNull();
    const row = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(row, '__proto__', {
      enumerable: true,
      value: 'literal',
    });
    expect(validationErrors(row, parsed.inputSchema)).toEqual([]);
    row.injected = true;
    expect(validationErrors(row, parsed.inputSchema)).toEqual([
      expect.objectContaining({ validator: 'additionalProperties' }),
    ]);
  });
});

describe('jSON Schema validation', () => {
  it('leaves blank/null/extra-property semantics entirely to schema', () => {
    const permissive = {
      type: 'object',
      properties: { title: { type: ['string', 'null'] } },
      required: ['title'],
      additionalProperties: false,
    } satisfies JsonSchema;
    expect(validationErrors({ title: '' }, permissive)).toEqual([]);
    expect(validationErrors({ title: null }, permissive)).toEqual([]);
    expect(validationErrors({ title: '', extra: true }, permissive)).toEqual([
      expect.objectContaining({ path: '', validator: 'additionalProperties' }),
    ]);
  });

  it('returns deterministic path, message, and validator diagnostics', () => {
    const schema = {
      type: 'object',
      properties: {
        contact: { type: 'string', format: 'email' },
        vote: { type: 'string', enum: ['accept', 'reject'] },
        nested: {
          type: 'object',
          properties: { score: { type: 'integer' } },
          required: ['score'],
        },
      },
      required: ['contact', 'vote', 'nested'],
    } satisfies JsonSchema;
    const errors = validationErrors(
      { contact: 'not-an-email', vote: 'maybe', nested: { score: 1.5 } },
      schema,
    );
    expect(errors.map(error => [error.path, error.validator])).toEqual([
      ['/contact', 'format'],
      ['/nested/score', 'type'],
      ['/vote', 'enum'],
    ]);
    expect(errors.every(error => error.message.length > 0)).toBe(true);
  });

  it('treats retained bigint values as JSON Schema integers', () => {
    const schema = { type: 'integer' } satisfies JsonSchema;
    expect(validationErrors(9223372036854775807n, schema)).toEqual([]);
  });

  it('compares adjacent bigint const and enum values without Number rounding', () => {
    const exactConst = {
      type: 'integer',
      const: 9007199254740993n,
    } satisfies JsonSchema;
    expect(validationErrors(9007199254740993n, exactConst)).toEqual([]);
    expect(validationErrors(9007199254740992n, exactConst)).toEqual([
      expect.objectContaining({ path: '', validator: 'const' }),
    ]);

    const exactEnum = {
      enum: [9007199254740993n, 9007199254740994n],
    } satisfies JsonSchema;
    expect(validationErrors(9007199254740994n, exactEnum)).toEqual([]);
    expect(validationErrors(9007199254740992n, exactEnum)).toEqual([
      expect.objectContaining({ validator: 'enum' }),
    ]);
  });

  it('evaluates bigint bounds and multipleOf exactly at adjacent values', () => {
    expect(
      validationErrors(9007199254740992n, {
        type: 'integer',
        minimum: 9007199254740993n,
      }),
    ).toEqual([expect.objectContaining({ validator: 'minimum' })]);
    expect(
      validationErrors(9007199254740993n, {
        type: 'integer',
        minimum: 9007199254740993n,
        maximum: 9007199254740993n,
      }),
    ).toEqual([]);
    expect(
      validationErrors(9007199254740994n, {
        exclusiveMaximum: 9007199254740994n,
      }),
    ).toEqual([expect.objectContaining({ validator: 'exclusiveMaximum' })]);
    expect(
      validationErrors(9007199254740993n, { multipleOf: 2n }),
    ).toEqual([expect.objectContaining({ validator: 'multipleOf' })]);
    expect(validationErrors(9007199254740994n, { multipleOf: 2n })).toEqual([]);
  });

  it('validates arbitrary-precision decimals without Number rounding', () => {
    const below = parseStrictJson('0.100000000000000000000');
    const exact = parseStrictJson('0.100000000000000000001');
    const above = parseStrictJson('0.100000000000000000002');
    const schema = {
      type: 'number',
      minimum: exact,
      maximum: exact,
      multipleOf: exact,
    } satisfies JsonSchema;

    expect(validationErrors(exact, schema)).toEqual([]);
    expect(validationErrors(below, schema)).toEqual([
      expect.objectContaining({ validator: 'minimum' }),
      expect.objectContaining({ validator: 'multipleOf' }),
    ]);
    expect(validationErrors(above, schema)).toEqual([
      expect.objectContaining({ validator: 'maximum' }),
      expect.objectContaining({ validator: 'multipleOf' }),
    ]);
    expect(
      validationErrors(parseStrictJson('9007199254740993.0'), {
        type: 'integer',
      }),
    ).toEqual([]);
  });

  it('preserves exact bigint semantics through local refs and combinators', () => {
    const schema = {
      $defs: {
        exact: { const: 9007199254740993n },
      },
      allOf: [
        { type: 'integer' },
        {
          anyOf: [
            { $ref: '#/$defs/exact' },
            { const: 9007199254740995n },
          ],
        },
        { not: { const: 9007199254740994n } },
      ],
    } satisfies JsonSchema;
    expect(validationErrors(9007199254740993n, schema)).toEqual([]);
    expect(validationErrors(9007199254740992n, schema)).not.toEqual([]);
    expect(validationErrors(9007199254740994n, schema)).not.toEqual([]);
  });

  it('uses exact nested equality and uniqueItems for bigint-containing values', () => {
    expect(
      validationErrors(
        { result: 9007199254740993n },
        { const: { result: 9007199254740993n } },
      ),
    ).toEqual([]);
    expect(
      validationErrors(
        { result: 9007199254740992n },
        { const: { result: 9007199254740993n } },
      ),
    ).toEqual([expect.objectContaining({ validator: 'const' })]);
    expect(
      validationErrors(
        [9007199254740992n, 9007199254740993n],
        { type: 'array', uniqueItems: true },
      ),
    ).toEqual([]);
    expect(
      validationErrors(
        [9007199254740993n, 9007199254740993n],
        { type: 'array', uniqueItems: true },
      ),
    ).toEqual([expect.objectContaining({ validator: 'uniqueItems' })]);
  });

  it('keeps propertyNames const and enum validation on AJV\'s synthetic key data', () => {
    expect(
      validationErrors(
        { foo: 1 },
        { type: 'object', propertyNames: { const: 'foo' } },
      ),
    ).toEqual([]);
    expect(
      validationErrors(
        { foo: 1 },
        { type: 'object', propertyNames: { enum: ['foo', 'bar'] } },
      ),
    ).toEqual([]);
    expect(
      validationErrors(
        { nope: 1 },
        { type: 'object', propertyNames: { const: 'foo' } },
      ),
    ).not.toEqual([]);
  });

  it('validates a patternProperties regex literally named __proto__', () => {
    const patterns = Object.fromEntries([
      ['__proto__', { type: 'string' }],
    ]);
    const schema = {
      type: 'object',
      patternProperties: patterns,
      additionalProperties: false,
    } satisfies JsonSchema;
    expect(validationErrors(JSON.parse('{"__proto__":"x"}'), schema)).toEqual([]);
    expect(
      validationErrors(JSON.parse('{"__proto__":42}'), schema),
    ).toEqual([expect.objectContaining({ path: '/__proto__', validator: 'type' })]);
  });

  it('honors __proto__ keys in required and dependency maps', () => {
    const properties = Object.fromEntries([
      ['__proto__', { type: 'string' }],
      ['other', { type: 'string' }],
    ]);
    const dependentSchemas = Object.fromEntries([
      ['__proto__', { required: ['other'] }],
    ]);
    const dependentRequired = Object.fromEntries([
      ['__proto__', ['other']],
    ]);
    const schema = {
      type: 'object',
      properties,
      required: ['__proto__'],
      dependentSchemas,
      dependentRequired,
      additionalProperties: false,
    } satisfies JsonSchema;
    expect(validationErrors(JSON.parse('{"__proto__":"x"}'), schema)).not.toEqual([]);
    expect(
      validationErrors(
        JSON.parse('{"__proto__":"x","other":"ok"}'),
        schema,
      ),
    ).toEqual([]);
  });

  it('fails deterministically for already-rounded unsafe Number values', () => {
    expect(() =>
      validationErrors(9007199254740992, { type: 'integer' }),
    ).toThrowError(expect.objectContaining({ code: 'inexact_number' }));
    expect(() =>
      validationErrors(1n, { const: 9007199254740992 }),
    ).toThrowError(expect.objectContaining({ code: 'inexact_numeric_schema' }));
  });

  it.each(['#/missing', 'urn:missing-schema'])(
    'maps unresolved references to a domain error (%s)',
    (reference) => {
      expect(() => validationErrors({}, { type: 'object', $ref: reference })).toThrowError(
        expect.objectContaining({ code: 'invalid_schema_reference' }),
      );
    },
  );

  it('maps a cyclic root reference to a domain error', () => {
    expect(() => validationErrors({}, { type: 'object', $ref: '#' })).toThrowError(
      expect.objectContaining({ code: 'invalid_schema_reference' }),
    );
  });
});

async function rawSpec(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'batch-spec-raw-test-'));
  roots.push(root);
  const path = join(root, 'task.md');
  await writeFile(path, content, 'utf8');
  return path;
}
