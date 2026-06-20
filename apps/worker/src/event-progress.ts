import type { RunExecutionEvent } from "./adapters/types.js";
import { redactSensitiveText } from "./redaction.js";

const DEFAULT_EVENT_PROGRESS_LIMIT = 6;
const EVENT_MESSAGE_LIMIT = 220;

const PROGRESS_EVENT_PREFIXES = ["codex.", "openhands."];
const LOW_SIGNAL_EVENT_TYPES = new Set([
  "codex.started",
  "codex.completed",
  "openhands.status",
  "openhands.llm_generation",
]);

export function summarizeExecutionEventsForProgress(
  events: readonly RunExecutionEvent[] | undefined,
  options: { limit?: number } = {},
): string | undefined {
  const selected = selectProgressEvents(
    events ?? [],
    options.limit ?? DEFAULT_EVENT_PROGRESS_LIMIT,
  );
  if (selected.length === 0) {
    return undefined;
  }

  const hidden = countProgressEligibleEvents(events ?? []) - selected.length;
  const lines = selected.map(
    (event) =>
      `- ${event.eventType}: ${truncate(redactSensitiveText(event.message), EVENT_MESSAGE_LIMIT)}`,
  );
  if (hidden > 0) {
    lines.push(`- ... ${hidden} more execution events are available in Run Detail.`);
  }

  return ["Agent Events: execution produced task-visible progress.", ...lines].join("\n");
}

function selectProgressEvents(
  events: readonly RunExecutionEvent[],
  limit: number,
): RunExecutionEvent[] {
  return events.filter(isProgressEligibleEvent).slice(0, Math.max(0, limit));
}

function countProgressEligibleEvents(events: readonly RunExecutionEvent[]): number {
  return events.filter(isProgressEligibleEvent).length;
}

function isProgressEligibleEvent(event: RunExecutionEvent): boolean {
  if (!PROGRESS_EVENT_PREFIXES.some((prefix) => event.eventType.startsWith(prefix))) {
    return false;
  }
  if (LOW_SIGNAL_EVENT_TYPES.has(event.eventType)) {
    return false;
  }
  return event.message.trim().length > 0;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
