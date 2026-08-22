import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

import { BatchTasksError } from '../src/errors.js';
import {
  BATCH_TOOL_NAMES,
  createBatchTasksServer,
  getAssignment,
  reportFailure,
  submitResult,
} from '../src/mcp-server.js';
import type { BatchRuntime } from '../src/state.js';
import { parseStrictJson } from '../src/storage.js';

function runtimeWith(overrides: Partial<BatchRuntime>): BatchRuntime {
  return overrides as BatchRuntime;
}

describe('batch_tasks MCP surface', () => {
  it('advertises exactly the three worker capability tools', async () => {
    expect(BATCH_TOOL_NAMES).toEqual([
      'get_assignment',
      'submit_result',
      'report_failure',
    ]);
    expect(new Set(BATCH_TOOL_NAMES).size).toBe(3);
    const runtime = runtimeWith({
      getAssignment: vi.fn().mockResolvedValue({
        id: 'one',
        input: { title: 'One' },
        diagnostics: { exact_integer: 9007199254740993n },
      }),
    });
    const server = createBatchTasksServer(runtime);
    expect(server).toBeInstanceOf(McpServer);
    const client = new Client({ name: 'batch-tests', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(BATCH_TOOL_NAMES);
      expect(
        tools.tools.find((tool) => tool.name === 'submit_result')?.inputSchema,
      ).toMatchObject({
        type: 'object',
        required: ['handle'],
        properties: {
          result: { type: 'object' },
          result_json: { type: 'string' },
        },
        oneOf: [
          { required: ['result'] },
          { required: ['result_json'] },
        ],
      });

      const result = await client.callTool({
        name: 'get_assignment',
        arguments: { handle: 'bta_handle' },
      });
      expect(result.structuredContent).toBeUndefined();
      expect(result.content).toHaveLength(1);
      const content = result.content[0];
      expect(content).toMatchObject({ type: 'text' });
      expect(parseStrictJson((content as { text: string }).text)).toEqual({
        id: 'one',
        input: { title: 'One' },
        diagnostics: { exact_integer: 9007199254740993n },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('performs a real stdio handshake without polluting protocol stdout', async () => {
    const transport = new StdioClientTransport({
      command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      args: ['--silent', 'batch-tasks', 'mcp'],
      cwd: process.cwd(),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-tests', version: '1.0.0' });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(BATCH_TOOL_NAMES);
    } finally {
      await client.close();
    }
  });

  it('delegates assignment retrieval without exposing another interface', async () => {
    const implementation = vi.fn().mockResolvedValue({
      id: 'one',
      input: { title: 'One' },
    });
    const runtime = runtimeWith({ getAssignment: implementation });

    await expect(getAssignment('bta_handle', runtime)).resolves.toEqual({
      id: 'one',
      input: { title: 'One' },
    });
    expect(implementation).toHaveBeenCalledWith('bta_handle');
  });

  it('passes pure result objects and failure diagnostics to the runtime', async () => {
    const submit = vi.fn().mockResolvedValue({ id: 'one', committed: true });
    const fail = vi.fn().mockResolvedValue({ id: 'two', terminal: true });
    const runtime = runtimeWith({
      submitResult: submit,
      reportFailure: fail,
    });

    await submitResult('handle-1', { vote: 'accept' }, runtime);
    await reportFailure('handle-2', 'cannot_review', 'Malformed proposal', runtime);

    expect(submit).toHaveBeenCalledWith('handle-1', { vote: 'accept' });
    expect(fail).toHaveBeenCalledWith(
      'handle-2',
      'cannot_review',
      'Malformed proposal',
    );
  });

  it('preserves magic own keys until task-specific output validation', async () => {
    const submit = vi.fn().mockResolvedValue({ id: 'one', committed: true });
    const runtime = runtimeWith({ submitResult: submit });
    const server = createBatchTasksServer(runtime);
    const client = new Client({ name: 'prototype-tests', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const result = JSON.parse(
      '{"__proto__":{"kept":true},"summary":"ok"}',
    ) as Record<string, unknown>;

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await client.callTool({
        name: 'submit_result',
        arguments: { handle: 'bta_handle', result },
      });
      const submitted = submit.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(Object.hasOwn(submitted, '__proto__')).toBe(true);
      expect(submitted.__proto__).toEqual({ kept: true });
      expect(Object.getPrototypeOf(submitted)).toBe(Object.prototype);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('parses result_json without losing unsafe integer literals or magic own keys', async () => {
    const submit = vi.fn().mockResolvedValue({ id: 'one', committed: true });
    const runtime = runtimeWith({ submitResult: submit });
    const server = createBatchTasksServer(runtime);
    const client = new Client({ name: 'exact-json-tests', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await client.callTool({
        name: 'submit_result',
        arguments: {
          handle: 'bta_handle',
          result_json:
            '{"exact":9223372036854775807,"__proto__":{"kept":true}}',
        },
      });

      const submitted = submit.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(submitted.exact).toBe(9223372036854775807n);
      expect(Object.hasOwn(submitted, '__proto__')).toBe(true);
      expect(submitted.__proto__).toEqual({ kept: true });
      expect(Object.getPrototypeOf(submitted)).toBe(Object.prototype);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    {
      name: 'both result forms',
      arguments: {
        handle: 'bta_handle',
        result: { summary: 'object' },
        result_json: '{"summary":"text"}',
      },
      expected: /exactly one|invalid params/i,
    },
    {
      name: 'neither result form',
      arguments: { handle: 'bta_handle' },
      expected: /exactly one|invalid params/i,
    },
    {
      name: 'invalid JSON text',
      arguments: { handle: 'bta_handle', result_json: '{' },
      expected: /invalid_result_json|valid strict JSON/i,
    },
    {
      name: 'non-object JSON text',
      arguments: { handle: 'bta_handle', result_json: '[1,2,3]' },
      expected: /invalid_result_json|JSON object/i,
    },
  ])('rejects $name', async ({ arguments: toolArguments, expected }) => {
    const submit = vi.fn().mockResolvedValue({ id: 'one', committed: true });
    const runtime = runtimeWith({ submitResult: submit });
    const server = createBatchTasksServer(runtime);
    const client = new Client({ name: 'invalid-json-tests', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      let failureText = '';
      try {
        const response = await client.callTool({
          name: 'submit_result',
          arguments: toolArguments,
        });
        expect(response.isError).toBe(true);
        failureText = response.content
          .filter((content) => content.type === 'text')
          .map((content) => content.text)
          .join('\n');
      } catch (error) {
        failureText = error instanceof Error ? error.message : String(error);
      }
      expect(failureText).toMatch(expected);
      expect(submit).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('serializes stable domain diagnostics into MCP tool errors', async () => {
    const runtime = runtimeWith({
      getAssignment: vi
        .fn()
        .mockRejectedValue(
          new BatchTasksError('handle_consumed', 'Handle was already consumed'),
        ),
    });

    const rejection = await getAssignment('used-handle', runtime).catch(
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(JSON.parse((rejection as Error).message)).toEqual({
      code: 'handle_consumed',
      message: 'Handle was already consumed',
    });
  });
});
