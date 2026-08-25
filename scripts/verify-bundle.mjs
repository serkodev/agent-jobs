import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const bundle = join(root, 'dist', 'agent-jobs.mjs');
const nodeExecutable = process.argv[2] ? resolve(process.argv[2]) : process.execPath;
const expectedTools = ['get_assignment', 'submit_result', 'report_failure'];

async function cli(cwd, executable, ...args) {
  const result = await execute(nodeExecutable, [executable, ...args], {
    cwd,
    env: { ...process.env, NODE_PATH: '' },
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

const files = await readdir(join(root, 'dist'));
assert.deepEqual(files, ['agent-jobs.mjs']);
const bundleText = await readFile(bundle, 'utf8');
assert.ok(bundleText.startsWith('#!/usr/bin/env node\n'));
for (const match of bundleText.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)) {
  assert.ok(match[1].startsWith('node:'), `unexpected external import: ${match[1]}`);
}

const temporary = await mkdtemp(join(tmpdir(), 'batch-bundle-verify-'));
const bareBundle = join(temporary, 'agent-jobs.mjs');
try {
  await copyFile(bundle, bareBundle);
  await chmod(bareBundle, 0o755);
  const help = await execute(nodeExecutable, [bareBundle, '--help'], {
    cwd: temporary,
    env: { ...process.env, NODE_PATH: '' },
  });
  assert.match(help.stdout, /init\s+Initialize Agent Jobs/);

  const inputPath = join(temporary, 'input.json');
  const specPath = join(temporary, 'task.md');
  const outputDir = join(temporary, 'output');
  await writeFile(
    inputPath,
    `${JSON.stringify([
      { id: 'one', title: 'One' },
      { id: 'two', title: 'Two' },
      { id: 'three', title: 'Three' },
    ])}\n`,
    'utf8',
  );
  await writeFile(
    specPath,
    `---
name: bundle-smoke
version: "1"
input_schema:
  type: object
  properties:
    id: { type: string }
    title: { type: string }
  required: [id, title]
  additionalProperties: false
output_schema:
  type: object
  properties:
    summary: { type: string, minLength: 1 }
  required: [summary]
  additionalProperties: false
---

Return one summary string.
`,
    'utf8',
  );

  const prepared = await cli(
    temporary,
    bareBundle,
    'prepare',
    '--input-data',
    inputPath,
    '--task-spec',
    specPath,
    '--id-column-key',
    'id',
    '--output-dir',
    outputDir,
  );
  assert.equal(prepared.ok, true);
  const leases = await cli(
    temporary,
    bareBundle,
    'next',
    '--output-dir',
    outputDir,
    '--invocation-id',
    prepared.invocation_id,
    '--count',
    '3',
  );
  assert.equal(leases.assignments.length, 3);

  const transport = new StdioClientTransport({
    command: nodeExecutable,
    args: [bareBundle, 'mcp'],
    cwd: temporary,
    env: {
      ...process.env,
      NODE_PATH: '',
      AGENT_JOBS_PROJECT_DIR: temporary,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bundle-verifier', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      expectedTools,
    );
    for (const lease of leases.assignments) {
      const assignment = await client.callTool({
        name: 'get_assignment',
        arguments: { handle: lease.handle },
      });
      const content = assignment.content.find((item) => item.type === 'text');
      assert.ok(content && content.type === 'text');
      const row = JSON.parse(content.text);
      const submitted = await client.callTool({
        name: 'submit_result',
        arguments: {
          handle: lease.handle,
          result_json: JSON.stringify({ summary: `processed-${row.id}` }),
        },
      });
      assert.notEqual(submitted.isError, true);
    }
  } finally {
    await client.close();
  }

  const validated = await cli(
    temporary,
    bareBundle,
    'validate',
    '--output-dir',
    outputDir,
    '--invocation-id',
    prepared.invocation_id,
  );
  assert.equal(validated.valid, true);
  const collected = await cli(
    temporary,
    bareBundle,
    'collect',
    '--output-dir',
    outputDir,
    '--invocation-id',
    prepared.invocation_id,
    '--format',
    'json',
  );
  assert.equal(collected.count, 3);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      node: (await execute(nodeExecutable, ['--version'])).stdout.trim(),
      bundle_bytes: Buffer.byteLength(bundleText),
      tools: expectedTools,
      rows: collected.count,
    })}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
