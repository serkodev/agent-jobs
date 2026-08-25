import { AgentJobsError } from "./errors.js";

export const MARKER_NAMES = new Set([
  "INPUT_DATA",
  "TASK_SPEC",
  "ID_COLUMN_KEY",
  "OUTPUT_DIR",
  "RECORDS_PATH",
  "MODEL",
  "REASONING_EFFORT",
  "MAX_CONCURRENCY",
  "MAX_RETRIES",
  "RETRY_INVALID",
  "ON_ERROR",
  "COLLECT_FORMAT",
  "POST_PROCESS_MODEL",
  "POST_PROCESS_REASONING_EFFORT",
] as const);

export type MarkerName = typeof MARKER_NAMES extends Set<infer T> ? T : never;
export type MarkerValue = string | number | boolean;
export type PromptMarkers = Partial<Record<MarkerName, MarkerValue>>;

const MARKER_RE = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*(.*?)\s*$/;

/** Extract and normalize supported `NAME: value` prompt marker lines. */
export function parsePromptMarkers(prompt: string): PromptMarkers {
  const values: PromptMarkers = {};
  const lines = prompt.split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = MARKER_RE.exec(lines[index] ?? "");
    if (!match || !MARKER_NAMES.has(match[1] as MarkerName)) {
      continue;
    }
    const name = match[1] as MarkerName;
    const raw = match[2] ?? "";
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      throw new AgentJobsError(
        "duplicate_marker",
        `Marker ${name} appears more than once`,
        { marker: name, line: index + 1 },
      );
    }
    values[name] = coerceMarker(name, raw);
  }
  return values;
}

/** Remove supported marker lines, leaving batch post-processing prose intact. */
export function stripPromptMarkers(prompt: string): string {
  return prompt
    .split(/\r\n|\n|\r/)
    .filter((line) => {
      const match = MARKER_RE.exec(line);
      return !match || !MARKER_NAMES.has(match[1] as MarkerName);
    })
    .join("\n")
    .trim();
}

function coerceMarker(name: MarkerName, raw: string): MarkerValue {
  if (raw.length === 0 && name !== "RECORDS_PATH") {
    throw new AgentJobsError(
      "empty_marker",
      `Marker ${name} must have a value`,
      { marker: name },
    );
  }

  if (name === "MAX_CONCURRENCY" || name === "MAX_RETRIES") {
    if (!/^[+-]?\d+$/.test(raw)) {
      throw new AgentJobsError(
        "invalid_marker",
        `Marker ${name} must be an integer`,
      );
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) {
      throw new AgentJobsError(
        "invalid_marker",
        `Marker ${name} must be a safe integer`,
      );
    }
    const minimum = name === "MAX_CONCURRENCY" ? 1 : 0;
    if (parsed < minimum) {
      throw new AgentJobsError(
        "invalid_marker",
        `Marker ${name} must be at least ${minimum}`,
      );
    }
    return parsed;
  }

  if (name === "RETRY_INVALID") {
    const normalized = raw.toLocaleLowerCase("en-US");
    if (["true", "yes", "1", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "0", "off"].includes(normalized)) {
      return false;
    }
    throw new AgentJobsError(
      "invalid_marker",
      "Marker RETRY_INVALID must be true or false",
    );
  }

  if (name === "ON_ERROR" && !["stop", "continue_successes"].includes(raw)) {
    throw new AgentJobsError(
      "invalid_marker",
      "Marker ON_ERROR must be stop or continue_successes",
    );
  }
  if (
    name === "COLLECT_FORMAT" &&
    !["none", "json", "jsonl", "csv"].includes(raw)
  ) {
    throw new AgentJobsError(
      "invalid_marker",
      "Marker COLLECT_FORMAT must be none, json, jsonl, or csv",
    );
  }
  return raw;
}
