import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import type { DatabaseSync } from 'node:sqlite';
import { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';

import { AgentJobsError } from './errors.js';

export const DATABASE_VERSION = 1;

export type AgentJobsDatabase = NodeSQLiteDatabase;
interface DatabaseMetadataRow {
  value?: unknown;
}

export interface OpenDatabase {
  client: DatabaseSync;
  close: () => void;
  db: AgentJobsDatabase;
}

const databaseOperationTails = new Map<string, Promise<void>>();

export interface OpenDatabaseOptions {
  initialize?: boolean;
}

/** Run a Drizzle callback under BEGIN IMMEDIATE to serialize queue writers. */
export async function writeTransaction<T>(
  client: DatabaseSync,
  operation: (database: AgentJobsDatabase) => Promise<T>,
): Promise<T> {
  return await runTransaction(client, 'BEGIN IMMEDIATE', operation);
}

/** Read multiple queries from one consistent SQLite snapshot. */
export async function readTransaction<T>(
  client: DatabaseSync,
  operation: (database: AgentJobsDatabase) => Promise<T>,
): Promise<T> {
  return await runTransaction(client, 'BEGIN', operation);
}

async function runTransaction<T>(
  client: DatabaseSync,
  begin: 'BEGIN' | 'BEGIN IMMEDIATE',
  operation: (database: AgentJobsDatabase) => Promise<T>,
): Promise<T> {
  client.exec(begin);
  try {
    const result = await operation(databaseForClient(client));
    client.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      client.exec('ROLLBACK');
    } catch {
      // Preserve the operation error.
    }
    throw error;
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
  try {
    const client = new SQLiteDatabase(path, {
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
    });
    try {
      client.exec(CONNECTION_SQL);
      if (options.initialize === true)
        initializeDatabase(client);
      ensureDatabaseVersion(client);
      let closed = false;
      return {
        client,
        close: () => {
          if (closed)
            return;
          closed = true;
          try {
            client.close();
          } finally {
            release();
          }
        },
        db: databaseForClient(client),
      };
    } catch (error) {
      try {
        client.close();
      } catch {
        // Preserve the initialization error.
      }
      throw error;
    }
  } catch (error) {
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

function initializeDatabase(client: DatabaseSync): void {
  const existing = client.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'database_metadata'
  `).get();
  if (existing === undefined)
    client.exec(SCHEMA_SQL);
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

function ensureDatabaseVersion(client: DatabaseSync): void {
  const selectVersion = client.prepare(
    'SELECT value FROM database_metadata WHERE key = ?',
  );
  let persisted = selectVersion.get('schema_version') as
    DatabaseMetadataRow | undefined;
  if (persisted === undefined) {
    client.prepare(`
      INSERT INTO database_metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO NOTHING
    `).run('schema_version', String(DATABASE_VERSION));
    persisted = selectVersion.get('schema_version') as
      DatabaseMetadataRow | undefined;
  }
  const version = persisted?.value;
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

function databaseForClient(client: DatabaseSync): NodeSQLiteDatabase {
  return drizzle({ client });
}
