import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const migrationsDirectory = join(root, 'packages', 'runtime', 'drizzle');
const outputPath = join(
  root,
  'packages',
  'runtime',
  'src',
  'database-migrations.generated.json',
);
const checkOnly = process.argv.includes('--check');
const migrationNamePattern = /^\d{14}_[\w-]+$/;

const entries = await readdir(migrationsDirectory, { withFileTypes: true });
const migrationDirectories = entries
  .filter(entry => entry.isDirectory() && migrationNamePattern.test(entry.name))
  .sort((left, right) => left.name.localeCompare(right.name));
const migrations = [];
for (const entry of migrationDirectories) {
  const source = await readFile(
    join(migrationsDirectory, entry.name, 'migration.sql'),
    'utf8',
  );
  migrations.push({
    name: entry.name,
    bps: true,
    folderMillis: migrationTimestamp(entry.name.slice(0, 14)),
    hash: createHash('sha256').update(source).digest('hex'),
    sql: source.split('--> statement-breakpoint'),
  });
}

if (migrations.length === 0)
  throw new Error('No database migrations were found');

const expected = `${JSON.stringify(migrations, null, 2)}\n`;
const existing = await readExistingOutput();
if (checkOnly) {
  if (existing !== expected) {
    throw new Error(
      'Embedded database migrations are stale; run pnpm db:embed',
    );
  }
} else if (existing !== expected) {
  await writeFile(outputPath, expected, 'utf8');
}

function isMissingFile(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readExistingOutput() {
  try {
    return await readFile(outputPath, 'utf8');
  } catch (error) {
    if (isMissingFile(error))
      return null;
    throw error;
  }
}

function migrationTimestamp(value) {
  return Date.UTC(
    Number.parseInt(value.slice(0, 4), 10),
    Number.parseInt(value.slice(4, 6), 10) - 1,
    Number.parseInt(value.slice(6, 8), 10),
    Number.parseInt(value.slice(8, 10), 10),
    Number.parseInt(value.slice(10, 12), 10),
    Number.parseInt(value.slice(12, 14), 10),
  );
}
