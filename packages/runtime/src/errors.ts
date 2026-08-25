/** Expected domain failures with stable, machine-readable error codes. */
export class AgentJobsError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AgentJobsError';
    this.code = code;
    if (details !== undefined && details !== null) {
      this.details = details;
    }
  }

  asDict(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) {
      result.details = this.details;
    }
    return result;
  }
}

export function isAgentJobsError(error: unknown): error is AgentJobsError {
  return error instanceof AgentJobsError;
}
