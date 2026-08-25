import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { BatchTasksError } from './errors.js';
import { BatchRuntime } from './state.js';
import { parseStrictJson, stringifyStrictJson } from './storage.js';

export const BATCH_TOOL_NAMES = [
  'get_assignment',
  'submit_result',
  'report_failure',
] as const;

type SubmitToolArguments =
  | {
      handle: string;
      result: Record<string, unknown>;
      result_json?: never;
    }
  | {
      handle: string;
      result?: never;
      result_json: string;
    };

const submitToolJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['handle'],
  properties: {
    handle: { type: 'string', minLength: 1 },
    result: { type: 'object' },
    result_json: { type: 'string' },
  },
  oneOf: [{ required: ['result'] }, { required: ['result_json'] }],
} as const;

/**
 * A Standard Schema passthrough keeps the advertised `result: object`
 * contract without Zod rebuilding the object and silently dropping an own
 * `__proto__` field before the task-specific schema validator receives it.
 * It also permits exact JSON text for values (notably integers) that cannot be
 * represented losslessly by the JSON-RPC client's JavaScript value model.
 */
const submitToolInputSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'batch-tasks-agent',
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

      const hasResult = Object.hasOwn(object, 'result');
      const hasResultJson = Object.hasOwn(object, 'result_json');
      if (hasResult === hasResultJson) {
        issues.push({
          message: 'exactly one of result or result_json is required',
        });
      } else if (
        hasResult &&
        (object.result === null ||
          typeof object.result !== 'object' ||
          Array.isArray(object.result))
      ) {
        issues.push({ message: 'result must be an object', path: [{ key: 'result' }] });
      } else if (hasResultJson && typeof object.result_json !== 'string') {
        issues.push({
          message: 'result_json must be a string',
          path: [{ key: 'result_json' }],
        });
      }
      for (const key of Object.keys(object)) {
        if (key !== 'handle' && key !== 'result' && key !== 'result_json') {
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

let runtimeInstance: BatchRuntime | undefined;

function defaultRuntime(): BatchRuntime {
  runtimeInstance ??= new BatchRuntime();
  return runtimeInstance;
}

/** Clear the process-local runtime. Intended for isolated unit tests only. */
export function resetMcpRuntime(): void {
  runtimeInstance = undefined;
}

function serializeDomainError(error: BatchTasksError): string {
  return stringifyStrictJson(error.asDict());
}

async function invokeRuntime<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BatchTasksError) {
      throw new Error(serializeDomainError(error));
    }
    throw error;
  }
}

export async function getAssignment(
  handle: string,
  runtime: BatchRuntime = defaultRuntime(),
): Promise<Awaited<ReturnType<BatchRuntime['getAssignment']>>> {
  return invokeRuntime(() => runtime.getAssignment(handle));
}

export async function submitResult(
  handle: string,
  result: unknown,
  runtime: BatchRuntime = defaultRuntime(),
): Promise<Awaited<ReturnType<BatchRuntime['submitResult']>>> {
  return invokeRuntime(() => runtime.submitResult(handle, result));
}

function parseResultJson(resultJson: string): Record<string, unknown> {
  let result: unknown;
  try {
    result = parseStrictJson(resultJson);
  } catch (error) {
    throw new BatchTasksError(
      'invalid_result_json',
      `result_json must contain valid strict JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new BatchTasksError(
      'invalid_result_json',
      'result_json must contain a JSON object',
    );
  }
  return result as Record<string, unknown>;
}

async function submitToolResult(
  arguments_: SubmitToolArguments,
  runtime: BatchRuntime,
): Promise<Awaited<ReturnType<BatchRuntime['submitResult']>>> {
  return invokeRuntime(() => {
    const result =
      typeof arguments_.result_json === 'string'
        ? parseResultJson(arguments_.result_json)
        : arguments_.result;
    return runtime.submitResult(arguments_.handle, result);
  });
}

export async function reportFailure(
  handle: string,
  code: string,
  message: string,
  runtime: BatchRuntime = defaultRuntime(),
): Promise<Awaited<ReturnType<BatchRuntime['reportFailure']>>> {
  return invokeRuntime(() => runtime.reportFailure(handle, code, message));
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (Array.isArray(value)) return value.map(jsonSafe);
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
export function createBatchTasksServer(
  runtime: BatchRuntime = new BatchRuntime(),
): McpServer {
  const server = new McpServer(
    { name: 'batch_tasks', version: '1.0.0' },
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
        'Validate and atomically commit one assignment. Pass result_json for exact JSON numeric literals, or result for a JSON object.',
      inputSchema: submitToolInputSchema,
    },
    async (arguments_) =>
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
  const server = createBatchTasksServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
