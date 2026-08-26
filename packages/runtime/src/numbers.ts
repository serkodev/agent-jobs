import type { Document } from 'yaml';
import {
  isInteger,
  isLosslessNumber,
  isSafeNumber,
  LosslessNumber,
} from 'lossless-json';
import { visit } from 'yaml';

export { LosslessNumber } from 'lossless-json';

export type JsonNumber = number | bigint | LosslessNumber;
export type IntegerRepresentation = 'safe-number' | 'bigint';

/** Parse one JSON number without losing integer or decimal precision. */
export function parseJsonNumber(
  value: string,
  integers: IntegerRepresentation = 'safe-number',
): JsonNumber {
  if (isInteger(value)) {
    const integer = BigInt(value);
    if (
      integers === 'safe-number'
      && integer >= BigInt(Number.MIN_SAFE_INTEGER)
      && integer <= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return Number(integer);
    }
    return integer;
  }
  return isSafeNumber(value) ? Number(value) : new LosslessNumber(value);
}

/** Test for the lossless decimal representation used at JSON boundaries. */
export function isPreciseNumber(value: unknown): value is LosslessNumber {
  return isLosslessNumber(value)
    && typeof value.value === 'string'
    && typeof value.toString === 'function';
}

/** Return the exact decimal/exponent token for a lossless number. */
export function preciseNumberText(value: LosslessNumber): string {
  return value.value;
}

/** Replace rounded YAML floating scalars with their exact source values. */
export function preserveYamlNumberPrecision(document: Document): void {
  visit(document, {
    Scalar(_key, node) {
      if (typeof node.value !== 'number' || typeof node.source !== 'string')
        return;
      const token = yamlFloatToJsonNumber(node.source);
      if (token !== null)
        node.value = parseJsonNumber(token);
    },
  });
}

function yamlFloatToJsonNumber(value: string): string | null {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))
    return null;
  let normalized = value.startsWith('+') ? value.slice(1) : value;
  normalized = normalized.replace(/^(-?)\./, '$10.');
  normalized = normalized.replace(/\.(?=e|$)/i, '.0');
  return normalized;
}
