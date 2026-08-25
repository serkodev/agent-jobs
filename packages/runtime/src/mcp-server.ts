import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { AgentJobsError } from './errors.js';
import { AgentJobsRuntime } from './state.js';
import { parseStrictJson, stringifyStrictJson } from './storage.js';

export const AGENT_JOBS_TOOL_NAMES = [
  'get_assignment',
  'submit_result',
  'report_failure',
] as const;

type SubmitToolArguments = {
  handle: string;
  result_format: 'json_object';
  result: Record<string, unknown>;
}
| {
  handle: string;
  result_format: 'json_text';
  result: string;
};

const submitToolJsonSchema = {
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
      description:
        'A JSON object for json_object, or exact JSON object text for json_text.',
    },
  },
} as const;

/**
 * A Standard Schema passthrough keeps the advertised schema flat because Claude
 * Code rejects MCP tools that use top-level `oneOf`. The format discriminator is
 * checked here without rebuilding JSON objects, which would silently drop an own
 * `__proto__` field before task-specific validation. Exact JSON text also keeps
 * numeric literals that the JSON-RPC client's JavaScript model cannot represent
 * losslessly.
 */
const submitToolInputSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'agent-jobs',
    types: undefined as unknown as {
      input: SubmitToolArguments;
      output: SubmitToolArguments;
    },
    validate(value: unknown) {
      const issues: Array<{
        message: string;
        path?: Array<{ key: PropertyKey }>;
      }> = [];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'arguments must be an object' }] };
      }
      const object = value as Record<string, unknown>;
      if (typeof object.handle !== 'string' || object.handle.length === 0) {
        issues.push({ message: 'handle must be a non-empty string', path: [{ key: 'handle' }] });
      }

      if (
        object.result_format !== 'json_object'
        && object.result_format !== 'json_text'
      ) {
        issues.push({
          message: 'result_format must be json_object or json_text',
          path: [{ key: 'result_format' }],
        });
      }

      if (!Object.hasOwn(object, 'result')) {
        issues.push({ message: 'result is required', path: [{ key: 'result' }] });
      } else if (
        object.result_format === 'json_object' && (
          object.result === null
          || typeof object.result !== 'object'
          || Array.isArray(object.result)
        )
      ) {
        issues.push({
          message: 'result must be an object for json_object',
          path: [{ key: 'result' }],
        });
      } else if (object.result_format === 'json_text' && typeof object.result !== 'string') {
        issues.push({
          message: 'result must be a string for json_text',
          path: [{ key: 'result' }],
        });
      }
      for (const key of Object.keys(object)) {
        if (key !== 'handle' && key !== 'result_format' && key !== 'result') {
          issues.push({ message: `unexpected property: ${key}`, path: [{ key }] });
        }
      }
      return issues.length > 0
        ? { issues }
        : { value: object as unknown as SubmitToolArguments };
    },
    jsonSchema: {
      input: () => submitToolJsonSchema,
      output: () => submitToolJsonSchema,
    },
  },
};

let runtimeInstance: AgentJobsRuntime | undefined;

function defaultRuntime(): AgentJobsRuntime {
  runtimeInstance ??= new AgentJobsRuntime();
  return runtimeInstance;
}

/** Clear the process-local runtime. Intended for isolated unit tests only. */
export function resetMcpRuntime(): void {
  runtimeInstance = undefined;
}

function serializeDomainError(error: AgentJobsError): string {
  return stringifyStrictJson(error.asDict());
}

async function invokeRuntime<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AgentJobsError) {
      throw new Error(serializeDomainError(error));
    }
    throw error;
  }
}

export async function getAssignment(
  handle: string,
  runtime: AgentJobsRuntime = defaultRuntime(),
): Promise<Awaited<ReturnType<AgentJobsRuntime['getAssignment']>>> {
  return invokeRuntime(() => runtime.getAssignment(handle));
}

export async function submitResult(
  handle: string,
  result: unknown,
  runtime: AgentJobsRuntime = defaultRuntime(),
): Promise<Awaited<ReturnType<AgentJobsRuntime['submitResult']>>> {
  return invokeRuntime(() => runtime.submitResult(handle, result));
}

function parseJsonTextResult(resultText: string): Record<string, unknown> {
  let result: unknown;
  try {
    result = parseStrictJson(resultText);
  } catch (error) {
    throw new AgentJobsError(
      'invalid_json_text_result',
      `result must contain valid strict JSON for json_text: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new AgentJobsError(
      'invalid_json_text_result',
      'result must contain a JSON object for json_text',
    );
  }
  return result as Record<string, unknown>;
}

async function submitToolResult(
  arguments_: SubmitToolArguments,
  runtime: AgentJobsRuntime,
): Promise<Awaited<ReturnType<AgentJobsRuntime['submitResult']>>> {
  return invokeRuntime(() => {
    const result = arguments_.result_format === 'json_text'
      ? parseJsonTextResult(arguments_.result)
      : arguments_.result;
    return runtime.submitResult(arguments_.handle, result);
  });
}

export async function reportFailure(
  handle: string,
  code: string,
  message: string,
  runtime: AgentJobsRuntime = defaultRuntime(),
): Promise<Awaited<ReturnType<AgentJobsRuntime['reportFailure']>>> {
  return invokeRuntime(() => runtime.reportFailure(handle, code, message));
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint')
    return value.toString(10);
  if (Array.isArray(value))
    return value.map(jsonSafe);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]),
    );
  }
  return value;
}

function toolResult(value: unknown): {
  content: [{ type: 'text'; text: string }];
  structuredContent: Record<string, unknown>;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Batch runtime tools must return a JSON object');
  }
  const structuredContent = jsonSafe(value) as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: stringifyStrictJson(structuredContent) }],
    structuredContent,
  };
}

/**
 * Assignment input can contain integers beyond JavaScript's safe range. Keep
 * those values as exact JSON numeric literals in text content instead of
 * coercing them to schema-incompatible strings for structuredContent.
 */
function exactJsonToolResult(value: unknown): {
  content: [{ type: 'text'; text: string }];
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Batch runtime tools must return a JSON object');
  }
  return {
    content: [{ type: 'text', text: stringifyStrictJson(value) }],
  };
}

/** Build one MCP server exposing only the three capability-based worker tools. */
export function createAgentJobsServer(
  runtime: AgentJobsRuntime = new AgentJobsRuntime(),
): McpServer {
  const server = new McpServer(
    { name: 'agent_jobs', version: '1.0.0' },
    {
      instructions:
        'Retrieve exactly one opaque assignment, then submit its result or report a failure. Do not access batch output files directly.',
    },
  );

  server.registerTool(
    'get_assignment',
    {
      description:
        'Consume an opaque handle and retrieve its single row, task instructions, and schemas.',
      inputSchema: z.object({ handle: z.string().min(1) }),
    },
    async ({ handle }) =>
      exactJsonToolResult(await getAssignment(handle, runtime)),
  );

  server.registerTool(
    'submit_result',
    {
      description:
        'Validate and atomically commit one assignment. Use result_format json_object for a JSON object, or json_text for exact JSON object text.',
      inputSchema: submitToolInputSchema,
    },
    async arguments_ =>
      toolResult(await submitToolResult(arguments_, runtime)),
  );

  server.registerTool(
    'report_failure',
    {
      description: 'Record a retryable or terminal failure for one assignment.',
      inputSchema: z.object({
        handle: z.string().min(1),
        code: z.string().min(1),
        message: z.string().min(1),
      }),
    },
    async ({ handle, code, message }) =>
      toolResult(await reportFailure(handle, code, message, runtime)),
  );

  return server;
}

/** Start the local server over stdio without writing application data to stdout. */
export async function runMcpServer(): Promise<void> {
  const server = createAgentJobsServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
