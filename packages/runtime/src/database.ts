import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import type { DatabaseSync } from 'node:sqlite';
import { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrateSync, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { databaseMigrations } from './database-migrations.js';
import { databaseMetadata } from './database-schema.js';
import { AgentJobsError } from './errors.js';

export const DATABASE_VERSION = 1;

export type AgentJobsDatabase = NodeSQLiteDatabase;

const sqliteSchema = sqliteTable('sqlite_master', {
  name: text('name').notNull(),
  type: text('type').notNull(),
});
const migrationLedger = sqliteTable('__drizzle_migrations', {
  name: text('name'),
});

export interface OpenDatabase {
  client: DatabaseSync;
  close: () => void;
  db: AgentJobsDatabase;
}

const databaseOperationTails = new Map<string, Promise<void>>();

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
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 30000;
`;
const MIGRATION_CONNECTION_SQL = 'PRAGMA journal_mode = WAL;';
const MIGRATION_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640];

export async function openAgentJobsDatabase(
  path: string,
): Promise<OpenDatabase> {
  const release = await acquireDatabaseOperation(path);
  try {
    const client = new SQLiteDatabase(path, {
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
    });
    try {
      client.exec(CONNECTION_SQL);
      const db = databaseForClient(client);
      await migrateDatabase(client, db);
      await ensureDatabaseVersion(db);
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
        db,
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

async function migrateDatabase(
  client: DatabaseSync,
  database: AgentJobsDatabase,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (!(await hasPendingMigrations(database)))
        return;
      client.exec(MIGRATION_CONNECTION_SQL);
      migrateSync(databaseMigrations, database._.session);
      return;
    } catch (error) {
      const retryDelay = MIGRATION_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined || !isDatabaseBusy(error))
        throw error;
      await delay(retryDelay);
    }
  }
}

async function hasPendingMigrations(
  database: AgentJobsDatabase,
): Promise<boolean> {
  const [ledgerTable] = await database
    .select({ name: sqliteSchema.name })
    .from(sqliteSchema)
    .where(and(
      eq(sqliteSchema.type, 'table'),
      eq(sqliteSchema.name, '__drizzle_migrations'),
    ))
    .limit(1);
  if (ledgerTable === undefined)
    return true;
  const applied = await database
    .select({ name: migrationLedger.name })
    .from(migrationLedger);
  const appliedNames = new Set(applied.map(migration => migration.name));
  return databaseMigrations.some(migration => !appliedNames.has(migration.name));
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

async function ensureDatabaseVersion(
  database: AgentJobsDatabase,
): Promise<void> {
  let version = await readDatabaseVersion(database);
  if (version === undefined) {
    await database
      .insert(databaseMetadata)
      .values({ key: 'schema_version', value: String(DATABASE_VERSION) })
      .onConflictDoNothing({ target: databaseMetadata.key });
    version = await readDatabaseVersion(database);
  }
  if (version !== String(DATABASE_VERSION)) {
    throw new AgentJobsError(
      'incompatible_database',
      `Agent job database schema ${String(version)} is not supported`,
      { expected: DATABASE_VERSION, actual: version ?? null },
    );
  }
}

async function readDatabaseVersion(
  database: AgentJobsDatabase,
): Promise<string | undefined> {
  const [metadata] = await database
    .select({ value: databaseMetadata.value })
    .from(databaseMetadata)
    .where(eq(databaseMetadata.key, 'schema_version'))
    .limit(1);
  return metadata?.value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDatabaseBusy(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (!seen.has(current)) {
    seen.add(current);
    const message = errorMessage(current);
    if (/\b(?:SQLITE_BUSY|SQLITE_LOCKED)\b|database (?:is|table is) locked/i.test(message))
      return true;
    if (typeof current !== 'object' || current === null || !('cause' in current))
      return false;
    current = current.cause;
  }
  return false;
}

function databaseForClient(client: DatabaseSync): NodeSQLiteDatabase {
  return drizzle({ client });
}
