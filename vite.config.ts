import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

import { defineConfig } from 'vite';

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

export default defineConfig({
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'main'],
  },
  build: {
    target: 'node20',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    copyPublicDir: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/bin.ts'),
      formats: ['es'],
      fileName: () => 'agent-jobs.mjs',
    },
    rolldownOptions: {
      platform: 'node',
      external: (id) => nodeBuiltins.has(id),
      output: {
        codeSplitting: false,
      },
    },
  },
});
