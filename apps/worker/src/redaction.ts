import type { RunExecutionEvent } from "./adapters/types.js";

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(?:sk|pk)_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{12,}\b/g, "[REDACTED_TOKEN]")
    .replace(
      /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key)[A-Za-z0-9_.-]*\s*[=:]\s*)\S+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]");
}

export function redactSensitivePayload<T>(value: T): T {
  if (typeof value === "string") {
    return redactSensitiveText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitivePayload(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSensitivePayload(item)]),
    ) as T;
  }

  return value;
}

export function redactExecutionEvents(
  events: readonly RunExecutionEvent[] | undefined,
): RunExecutionEvent[] {
  return (events ?? []).map((event) => redactSensitivePayload(event));
}
