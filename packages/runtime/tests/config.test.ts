import { describe, expect, it } from 'vitest';

import { parsePromptMarkers, stripPromptMarkers } from '../src/config.js';
import { AgentJobsError } from '../src/errors.js';

describe('prompt marker configuration', () => {
  it('coerces every supported typed marker', () => {
    const prompt = `
Please review these records and then summarize common themes.

INPUT_DATA: data/rows.json
TASK_SPEC: spec/review.md
ID_COLUMN_KEY: proposal_id
OUTPUT_DIR: output/run-1
RECORDS_PATH: /payload/records
MODEL: gpt-5.6-sol
REASONING_EFFORT: high
MAX_CONCURRENCY: 8
MAX_RETRIES: 2
RETRY_INVALID: yes
ON_ERROR: continue_successes
COLLECT_FORMAT: csv
POST_PROCESS_MODEL: gpt-5.6-terra
POST_PROCESS_REASONING_EFFORT: medium
`;

    expect(parsePromptMarkers(prompt)).toEqual({
      INPUT_DATA: 'data/rows.json',
      TASK_SPEC: 'spec/review.md',
      ID_COLUMN_KEY: 'proposal_id',
      OUTPUT_DIR: 'output/run-1',
      RECORDS_PATH: '/payload/records',
      MODEL: 'gpt-5.6-sol',
      REASONING_EFFORT: 'high',
      MAX_CONCURRENCY: 8,
      MAX_RETRIES: 2,
      RETRY_INVALID: true,
      ON_ERROR: 'continue_successes',
      COLLECT_FORMAT: 'csv',
      POST_PROCESS_MODEL: 'gpt-5.6-terra',
      POST_PROCESS_REASONING_EFFORT: 'medium',
    });
  });

  it('keeps unknown markers and post-processing prose', () => {
    expect(
      stripPromptMarkers(`
INPUT_DATA: rows.json
CUSTOM_NOTE: this is ordinary prose
After collecting, summarize disagreements.
OUTPUT_DIR: output
`),
    ).toBe(
      'CUSTOM_NOTE: this is ordinary prose\nAfter collecting, summarize disagreements.',
    );
  });

  it('allows only RECORDS_PATH to be empty', () => {
    expect(parsePromptMarkers('RECORDS_PATH:')).toEqual({ RECORDS_PATH: '' });
    expect(() => parsePromptMarkers('MODEL:')).toThrowError(
      expect.objectContaining({ code: 'empty_marker' }),
    );
  });

  it('rejects duplicate markers with line details', () => {
    try {
      parsePromptMarkers('MODEL: one\nMODEL: two');
      throw new Error('expected marker parsing to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentJobsError);
      expect(error).toMatchObject({
        code: 'duplicate_marker',
        details: { marker: 'MODEL', line: 2 },
      });
    }
  });

  it.each([
    'MAX_CONCURRENCY: 0',
    'MAX_CONCURRENCY: many',
    'MAX_CONCURRENCY: 1e3',
    'MAX_RETRIES: -1',
    'MAX_RETRIES: 1.5',
    'RETRY_INVALID: maybe',
    'ON_ERROR: ignore',
    'COLLECT_FORMAT: parquet',
  ])('rejects invalid typed marker %s', (line) => {
    expect(() => parsePromptMarkers(line)).toThrowError(
      expect.objectContaining({ code: 'invalid_marker' }),
    );
  });

  it.each([
    ['true', true],
    ['ON', true],
    ['1', true],
    ['false', false],
    ['No', false],
    ['0', false],
  ])('normalizes RETRY_INVALID %s', (raw, expected) => {
    expect(parsePromptMarkers(`RETRY_INVALID: ${raw}`).RETRY_INVALID).toBe(expected);
  });
});
