import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();

async function json(path: string): Promise<Record<string, unknown>> {
  const contents = await readFile(join(root, path), 'utf8');
  return JSON.parse(contents) as Record<string, unknown>;
}

describe('package build contract', () => {
  it('keeps installer and runtime as one-way workspace packages', async () => {
    const installer = await json('package.json');
    const runtime = await json('packages/runtime/package.json');
    const workspace = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');

    expect(installer).toMatchObject({
      name: 'batch-tasks-agent',
      version: '0.3.0',
      private: true,
      bin: { 'batch-tasks': 'dist/batch-tasks.mjs' },
      files: ['dist/batch-tasks.mjs', 'README.md'],
      devDependencies: {
        '@batch-tasks/runtime': 'workspace:*',
        vite: '8.2.1',
      },
    });
    expect(installer.dependencies).toBeUndefined();
    expect(runtime).toMatchObject({
      name: '@batch-tasks/runtime',
      version: '0.3.0',
      private: true,
      description: expect.stringContaining('MCP server'),
    });
    expect(runtime.dependencies).toMatchObject({
      '@modelcontextprotocol/server': '^2.0.0',
      ajv: '^8.20.0',
      zod: '^4.1.12',
    });
    expect(workspace).toContain('packages/*');
  });

  it('uses Vite library mode for one Node 20 ESM executable bundle', async () => {
    const packageJson = await json('package.json');
    const scripts = packageJson.scripts as Record<string, string>;
    const config = await readFile(join(root, 'vite.config.ts'), 'utf8');

    expect(scripts.build).toContain('vite build');
    expect(scripts['batch-tasks']).toBe('node dist/batch-tasks.mjs');
    expect(scripts.build).not.toContain('sync-skill-bundle');
    expect(scripts.build).not.toContain('tsdown');
    expect(scripts.build).not.toContain('generate:templates');
    expect(config).toContain("target: 'node20'");
    expect(config).toContain("platform: 'node'");
    expect(config).toContain("conditions: ['node']");
    expect(config).toContain("formats: ['es']");
    expect(config).toContain("fileName: () => 'batch-tasks.mjs'");
    expect(config).toContain('codeSplitting: false');
    expect(config).toContain('external: (id) => nodeBuiltins.has(id)');
  });

  it('keeps a dedicated executable entry separate from library exports', async () => {
    const bin = await readFile(join(root, 'src', 'bin.ts'), 'utf8');
    const index = await readFile(join(root, 'src', 'index.ts'), 'utf8');

    expect(bin.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(bin).toContain('void main().then');
    expect(index).toContain("export * from '@batch-tasks/runtime'");
    expect(index).not.toContain('process.argv');
    expect(index).not.toContain('#!/usr/bin/env node');
  });

  it('imports install files directly from readable Vite raw templates', async () => {
    const installerTemplates = await readFile(
      join(root, 'src', 'install-templates.ts'),
      'utf8',
    );
    const tsconfig = await json('tsconfig.json');
    const compilerOptions = tsconfig.compilerOptions as { types: string[] };
    const sharedSkill = await readFile(
      join(root, 'templates', 'install', 'shared', 'SKILL.md'),
      'utf8',
    );
    const claudeWorker = await readFile(
      join(root, 'templates', 'install', 'claude', 'agents', 'batch_worker.md'),
      'utf8',
    );
    const codexWorker = await readFile(
      join(root, 'templates', 'install', 'codex', 'agents', 'batch_worker.toml'),
      'utf8',
    );
    const codexConfig = await readFile(
      join(root, 'templates', 'install', 'codex', 'config.toml'),
      'utf8',
    );
    const openAiMetadata = await readFile(
      join(root, 'templates', 'install', 'codex', 'openai.yaml'),
      'utf8',
    );

    expect(installerTemplates).toContain("shared/SKILL.md?raw'");
    expect(installerTemplates).toContain("batch_worker.md?raw'");
    expect(installerTemplates).toContain("batch_worker.toml?raw'");
    expect(installerTemplates).toContain("config.toml?raw'");
    expect(installerTemplates).toContain("openai.yaml?raw'");
    expect(installerTemplates).not.toContain('generated/install-markdown');
    expect(installerTemplates).not.toContain('name = "batch_worker"');
    expect(installerTemplates).not.toContain('interface:\n  display_name:');
    expect(compilerOptions.types).toContain('vite/client');
    expect(sharedSkill).toContain('{{BATCH_TASKS_CLI}} prepare');
    expect(sharedSkill).toContain('{{WORKER_ORCHESTRATION}}');
    expect(claudeWorker).toContain('mcp__batch_tasks__get_assignment');
    expect(codexWorker).toContain('args = [{{SCRIPT_PATH}}, "mcp"]');
    expect(codexConfig).toContain('{{PROJECT_ENV_SECTION}}');
    expect(openAiMetadata).toContain('display_name: "Batch Tasks"');
  });
});
