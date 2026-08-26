import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  out: './packages/runtime/drizzle',
  schema: './packages/runtime/src/database-schema.ts',
});
