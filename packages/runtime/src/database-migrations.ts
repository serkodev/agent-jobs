import type { MigrationMeta } from 'drizzle-orm/migrator';

import migrations from './database-migrations.generated.json' with { type: 'json' };

export const databaseMigrations = migrations satisfies MigrationMeta[];
