import type { BaseIssue } from 'valibot';
import type { RecordSchema } from './schema.js';
import * as v from 'valibot';

export const jsonObjectSchema = v.custom<Record<string, unknown>>(
  value => value !== null && typeof value === 'object' && !Array.isArray(value),
  'Expected an object',
);

const recordSchema = v.custom<RecordSchema>(
  value => value !== null && typeof value === 'object' && !Array.isArray(value),
  'Expected an object',
);

export const nonBlankStringSchema = v.pipe(
  v.string(),
  v.check(value => value.trim().length > 0, 'Expected a non-empty string'),
);

export const recordSchemaConfigSchema = v.strictObject({
  loose: v.optional(v.boolean(), false),
  schema: recordSchema,
});

export function valibotDiagnostics(
  issues: readonly BaseIssue<unknown>[],
): Array<{ path: string; message: string; validator: string }> {
  return issues.map(issue => ({
    path: issue.path === undefined
      ? ''
      : `/${issue.path.map(item => escapePointer(String(item.key))).join('/')}`,
    message: issue.message,
    validator: issue.type,
  }));
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
