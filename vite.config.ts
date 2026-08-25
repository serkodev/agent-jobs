import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

import { defineConfig } from 'vite';

import packageMetadata from './package.json' with { type: 'json' };

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

export default defineConfig({
  define: {
    __AGENT_JOBS_PACKAGE_VERSION__: JSON.stringify(packageMetadata.version),
  },
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
