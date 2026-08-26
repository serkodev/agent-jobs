import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { AgentJobsError } from './errors.js';
import { isPreciseNumber, preciseNumberText } from './numbers.js';
import { recordSchemaToStandardSchema } from './schema.js';
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

/**
 * The shared field DSL keeps the advertised schema flat because Claude Code
 * rejects MCP tools that use top-level `oneOf`. The discriminator refinement does
 * not rebuild objects, so an own `__proto__` field survives task validation.
 */
const submitToolInputSchema = recordSchemaToStandardSchema<SubmitToolArguments>({
  handle: { type: 'string', minLength: 1 },
  result_format: {
    type: 'string',
    enum: ['json_object', 'json_text'],
  },
  result: {
    type: ['object', 'string'],
    loose: true,
    description:
      'A JSON object for json_object, or exact JSON object text for json_text.',
  },
}, {
  refine(arguments_) {
    if (!Object.hasOwn(arguments_, 'result'))
      return [];
    if (
      arguments_.result_format === 'json_object'
      && (
        arguments_.result === null
        || typeof arguments_.result !== 'object'
        || Array.isArray(arguments_.result)
      )
    ) {
      return [{
        path: '/result',
        message: 'result must be an object for json_object',
        validator: 'result_format',
      }];
    }
    if (
      arguments_.result_format === 'json_text'
      && typeof arguments_.result !== 'string'
    ) {
      return [{
        path: '/result',
        message: 'result must be a string for json_text',
        validator: 'result_format',
      }];
    }
    return [];
  },
});

const getAssignmentToolInputSchema = recordSchemaToStandardSchema<{
  handle: string;
}>({
  handle: { type: 'string', minLength: 1 },
});

const reportFailureToolInputSchema = recordSchemaToStandardSchema<{
  handle: string;
  code: string;
  message: string;
}>({
  handle: { type: 'string', minLength: 1 },
  code: { type: 'string', minLength: 1 },
  message: { type: 'string', minLength: 1 },
});

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
  if (isPreciseNumber(value))
    return preciseNumberText(value);
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
      inputSchema: getAssignmentToolInputSchema,
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
      inputSchema: reportFailureToolInputSchema,
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
