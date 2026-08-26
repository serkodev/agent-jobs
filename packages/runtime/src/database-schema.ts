import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const databaseMetadata = sqliteTable('database_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const jobs = sqliteTable('jobs', {
  jobId: text('job_id').primaryKey(),
  stateVersion: integer('state_version').notNull(),
  sessionStatus: text('session_status').notNull(),
  supersededAt: text('superseded_at'),
  supersededByJobId: text('superseded_by_job_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  inputData: text('input_data').notNull(),
  taskSpec: text('task_spec').notNull(),
  outputDir: text('output_dir').notNull(),
  idColumnKey: text('id_column_key').notNull(),
  recordsPath: text('records_path'),
  sourceHash: text('source_hash').notNull(),
  taskHash: text('task_hash').notNull(),
  executionHash: text('execution_hash').notNull(),
  specJson: text('spec_json').notNull(),
  settingsJson: text('settings_json').notNull(),
  cacheDiagnosticsJson: text('cache_diagnostics_json').notNull(),
});

export const currentJob = sqliteTable('current_job', {
  slot: integer('slot').primaryKey(),
  jobId: text('job_id')
    .notNull()
    .references(() => jobs.jobId),
});

export const results = sqliteTable(
  'results',
  {
    resultId: integer('result_id').primaryKey({ autoIncrement: true }),
    recordId: text('record_id').notNull(),
    inputHash: text('input_hash').notNull(),
    executionHash: text('execution_hash').notNull(),
    outputJson: text('output_json').notNull(),
    outputHash: text('output_hash').notNull(),
    createdAt: text('created_at').notNull(),
  },
  table => [
    index('results_lookup_index').on(
      table.recordId,
      table.inputHash,
      table.executionHash,
    ),
  ],
);

export const jobRecords = sqliteTable(
  'job_records',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.jobId),
    inputIndex: integer('input_index').notNull(),
    recordId: text('record_id').notNull(),
    inputHash: text('input_hash').notNull(),
    inputJson: text('input_json').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    leaseToken: text('lease_token'),
    lastErrorJson: text('last_error_json'),
    leasedAt: text('leased_at'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    cacheValidationErrorsJson: text('cache_validation_errors_json'),
    resultId: integer('result_id').references(() => results.resultId),
  },
  table => [
    primaryKey({ columns: [table.jobId, table.recordId] }),
    uniqueIndex('job_records_order_unique').on(table.jobId, table.inputIndex),
    uniqueIndex('job_records_lease_unique').on(table.leaseToken),
    index('job_records_queue_index').on(table.jobId, table.status, table.inputIndex),
  ],
);

export const databaseSchema = {
  currentJob,
  databaseMetadata,
  jobRecords,
  jobs,
  results,
};
