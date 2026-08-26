import type { Client, Transaction } from '@libsql/client';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client/sqlite3';
import { drizzle } from 'drizzle-orm/libsql/sqlite3';

import { databaseSchema } from './database-schema.js';
import { AgentJobsError } from './errors.js';

export const DATABASE_VERSION = 1;

export type AgentJobsDatabase = LibSQLDatabase<typeof databaseSchema>;

export interface OpenDatabase {
  client: Client;
  close: () => void;
  db: AgentJobsDatabase;
}

const databaseOperationTails = new Map<string, Promise<void>>();

export interface OpenDatabaseOptions {
  initialize?: boolean;
}

/** Run a Drizzle callback under BEGIN IMMEDIATE to serialize queue writers. */
export async function writeTransaction<T>(
  client: Client,
  operation: (database: AgentJobsDatabase) => Promise<T>,
): Promise<T> {
  const transaction = await client.transaction('write');
  try {
    const result = await operation(databaseForTransaction(transaction));
    await transaction.commit();
    return result;
  } catch (error) {
    try {
      await transaction.rollback();
    } catch {
      // Preserve the operation error; close() below still releases resources.
    }
    throw error;
  } finally {
    transaction.close();
  }
}

const CONNECTION_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 30000;
`;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS database_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  state_version INTEGER NOT NULL,
  session_status TEXT NOT NULL CHECK (session_status IN ('active', 'superseded')),
  superseded_at TEXT,
  superseded_by_job_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  input_data TEXT NOT NULL,
  task_spec TEXT NOT NULL,
  output_dir TEXT NOT NULL,
  id_column_key TEXT NOT NULL,
  records_path TEXT,
  source_hash TEXT NOT NULL,
  task_hash TEXT NOT NULL,
  execution_hash TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  cache_diagnostics_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS current_job (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  job_id TEXT NOT NULL REFERENCES jobs(job_id)
);

CREATE TABLE IF NOT EXISTS results (
  result_id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  execution_hash TEXT NOT NULL,
  output_json TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS results_lookup_index
ON results(record_id, input_hash, execution_hash);

CREATE TABLE IF NOT EXISTS job_records (
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  input_index INTEGER NOT NULL,
  record_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending', 'leased', 'running', 'completed',
      'skipped_valid', 'skipped_invalid', 'failed'
    )
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT UNIQUE,
  last_error_json TEXT,
  leased_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  cache_validation_errors_json TEXT,
  result_id INTEGER REFERENCES results(result_id),
  PRIMARY KEY (job_id, record_id),
  UNIQUE (job_id, input_index)
);

CREATE INDEX IF NOT EXISTS job_records_queue_index
ON job_records(job_id, status, input_index);
`;

export async function openAgentJobsDatabase(
  path: string,
  options: OpenDatabaseOptions = {},
): Promise<OpenDatabase> {
  const release = await acquireDatabaseOperation(path);
  const client = createClient({ url: `file:${path}` });
  try {
    await client.executeMultiple(CONNECTION_SQL);
    if (options.initialize === true)
      await initializeDatabase(client);
    await ensureDatabaseVersion(client);
    let closed = false;
    return {
      client,
      close: () => {
        if (closed)
          return;
        closed = true;
        client.close();
        release();
      },
      db: drizzle({ client, schema: databaseSchema }),
    };
  } catch (error) {
    client.close();
    release();
    if (error instanceof AgentJobsError)
      throw error;
    throw new AgentJobsError(
      'storage_error',
      `Could not open agent job database: ${errorMessage(error)}`,
      { path },
    );
  }
}

async function initializeDatabase(client: Client): Promise<void> {
  const existing = await client.execute({
    sql: `
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'database_metadata'
    `,
    args: [],
  });
  if (existing.rows.length === 0)
    await client.executeMultiple(SCHEMA_SQL);
}

async function acquireDatabaseOperation(path: string): Promise<() => void> {
  const previous = databaseOperationTails.get(path) ?? Promise.resolve();
  let unlock: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = previous.then(() => gate);
  databaseOperationTails.set(path, tail);
  await previous;
  return () => {
    unlock?.();
    unlock = undefined;
    if (databaseOperationTails.get(path) === tail)
      databaseOperationTails.delete(path);
  };
}

async function ensureDatabaseVersion(client: Client): Promise<void> {
  const existing = await client.execute({
    sql: 'SELECT value FROM database_metadata WHERE key = ?',
    args: ['schema_version'],
  });
  if (existing.rows.length === 0) {
    await client.execute({
      sql: `
        INSERT INTO database_metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO NOTHING
      `,
      args: ['schema_version', String(DATABASE_VERSION)],
    });
  }
  const persisted = existing.rows.length === 0
    ? await client.execute({
        sql: 'SELECT value FROM database_metadata WHERE key = ?',
        args: ['schema_version'],
      })
    : existing;
  const version = persisted.rows[0]?.value;
  if (version !== String(DATABASE_VERSION)) {
    throw new AgentJobsError(
      'incompatible_database',
      `Agent job database schema ${String(version)} is not supported`,
      { expected: DATABASE_VERSION, actual: version ?? null },
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function databaseForTransaction(transaction: Transaction): AgentJobsDatabase {
  // Drizzle only needs execute/batch here, both of which Transaction implements.
  return drizzle({
    client: transaction as unknown as Client,
    schema: databaseSchema,
  });
}
