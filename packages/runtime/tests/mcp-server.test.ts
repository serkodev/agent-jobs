import type { AgentJobsRuntime } from '../src/state.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';

import { describe, expect, it, vi } from 'vitest';
import { AgentJobsError } from '../src/errors.js';
import {
  AGENT_JOBS_TOOL_NAMES,
  createAgentJobsServer,
  getAssignment,
  reportFailure,
  submitResult,
} from '../src/mcp-server.js';
import { parseStrictJson } from '../src/storage.js';

function runtimeWith(overrides: Partial<AgentJobsRuntime>): AgentJobsRuntime {
  return overrides as AgentJobsRuntime;
}

describe('agent_jobs MCP surface', () => {
  it('advertises exactly the three worker capability tools', async () => {
    expect(AGENT_JOBS_TOOL_NAMES).toEqual([
      'get_assignment',
      'submit_result',
      'report_failure',
    ]);
    expect(new Set(AGENT_JOBS_TOOL_NAMES).size).toBe(3);
    const runtime = runtimeWith({
      getAssignment: vi.fn().mockResolvedValue({
        id: 'one',
        input: { title: 'One' },
        diagnostics: { exact_integer: 9007199254740993n },
      }),
    });
    const server = createAgentJobsServer(runtime);
    expect(server).toBeInstanceOf(McpServer);
    const client = new Client({ name: 'batch-tests', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toEqual(AGENT_JOBS_TOOL_NAMES);
      const submitInputSchema = tools.tools.find(
        tool => tool.name === 'submit_result',
      )?.inputSchema;
      expect(submitInputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['handle', 'result_format', 'result'],
        properties: {
          handle: { type: 'string', minLength: 1 },
          result_format: {
            type: 'string',
            enum: ['json_object', 'json_text'],
          },
          result: {
            type: ['object', 'string'],
            additionalProperties: true,
          },
        },
      });
      expect(submitInputSchema).not.toHaveProperty('oneOf');
      expect(tools.tools.find(
        tool => tool.name === 'get_assignment',
      )?.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['handle'],
        properties: { handle: { type: 'string', minLength: 1 } },
      });
      expect(tools.tools.find(
        tool => tool.name === 'report_failure',
      )?.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['handle', 'code', 'message'],
      });

      const result = await client.callTool({
        name: 'get_assignment',
        arguments: { handle: 'aj_handle' },
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
    const mcpModule = new URL('../src/mcp-server.ts', import.meta.url).href;
    const mcpScript = `import { runMcpServer } from ${JSON.stringify(mcpModule)}; await runMcpServer();`;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        mcpScript,
      ],
      cwd: process.cwd(),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-tests', version: '1.0.0' });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toEqual(AGENT_JOBS_TOOL_NAMES);
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

    await expect(getAssignment('aj_handle', runtime)).resolves.toEqual({
      id: 'one',
      input: { title: 'One' },
    });
    expect(implementation).toHaveBeenCalledWith('aj_handle');
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
    const server = createAgentJobsServer(runtime);
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
        arguments: {
          handle: 'aj_handle',
          result_format: 'json_object',
          result,
        },
      });
      const submitted = submit.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(Object.hasOwn(submitted, '__proto__')).toBe(true);
      expect(Reflect.get(submitted, '__proto__')).toEqual({ kept: true });
      expect(Object.getPrototypeOf(submitted)).toBe(Object.prototype);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('parses json_text without losing unsafe integer literals or magic own keys', async () => {
    const submit = vi.fn().mockResolvedValue({ id: 'one', committed: true });
    const runtime = runtimeWith({ submitResult: submit });
    const server = createAgentJobsServer(runtime);
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
          handle: 'aj_handle',
          result_format: 'json_text',
          result:
            '{"exact":9223372036854775807,"__proto__":{"kept":true}}',
        },
      });

      const submitted = submit.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(submitted.exact).toBe(9223372036854775807n);
      expect(Object.hasOwn(submitted, '__proto__')).toBe(true);
      expect(Reflect.get(submitted, '__proto__')).toEqual({ kept: true });
      expect(Object.getPrototypeOf(submitted)).toBe(Object.prototype);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    {
      name: 'a missing result format',
      arguments: {
        handle: 'aj_handle',
        result: { summary: 'object' },
      },
      expected: /result_format|invalid params/i,
    },
    {
      name: 'a missing result',
      arguments: { handle: 'aj_handle', result_format: 'json_object' },
      expected: /result is required|invalid params/i,
    },
    {
      name: 'an unsupported result format',
      arguments: {
        handle: 'aj_handle',
        result_format: 'yaml',
        result: 'summary: text',
      },
      expected: /result_format|invalid params/i,
    },
    {
      name: 'a string passed as json_object',
      arguments: {
        handle: 'aj_handle',
        result_format: 'json_object',
        result: '{"summary":"text"}',
      },
      expected: /result must be an object|invalid params/i,
    },
    {
      name: 'an object passed as json_text',
      arguments: {
        handle: 'aj_handle',
        result_format: 'json_text',
        result: { summary: 'object' },
      },
      expected: /result must be a string|invalid params/i,
    },
    {
      name: 'invalid JSON text',
      arguments: {
        handle: 'aj_handle',
        result_format: 'json_text',
        result: '{',
      },
      expected: /invalid_json_text_result|valid strict JSON/i,
    },
    {
      name: 'non-object JSON text',
      arguments: {
        handle: 'aj_handle',
        result_format: 'json_text',
        result: '[1,2,3]',
      },
      expected: /invalid_json_text_result|JSON object/i,
    },
  ])('rejects $name', async ({ arguments: toolArguments, expected }) => {
    const submit = vi.fn().mockResolvedValue({ id: 'one', committed: true });
    const runtime = runtimeWith({ submitResult: submit });
    const server = createAgentJobsServer(runtime);
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
          .filter(content => content.type === 'text')
          .map(content => content.text)
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
          new AgentJobsError('handle_consumed', 'Handle was already consumed'),
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
