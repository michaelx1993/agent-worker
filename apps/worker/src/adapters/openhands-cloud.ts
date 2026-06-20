import { setTimeout as sleep } from "node:timers/promises";
import { defaultNextStateForRole } from "../lifecycle.js";
import type {
  ExecutionAdapter,
  RunExecutionEvent,
  RunExecutionInput,
  RunExecutionResult,
  RunTraceRef,
} from "./types.js";

interface OpenHandsCloudAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  selectedRepository?: string;
  eventLogPathTemplate?: string;
  startTimeoutMs?: number;
  executionTimeoutMs?: number;
  startPollIntervalMs?: number;
  executionPollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

interface StartConversationResponse {
  id?: string;
  app_conversation_id?: string;
  status?: string;
  error?: string;
}

interface StartTaskStatus {
  id?: string;
  status?: string;
  app_conversation_id?: string;
  error?: string;
}

interface ConversationStatus {
  id: string;
  sandbox_status?: string;
  execution_status?: string;
  event_log_uri?: string;
  eventLogUri?: string;
  event_log_url?: string;
  eventLogUrl?: string;
  events_url?: string;
  eventsUrl?: string;
  log_url?: string;
  logUrl?: string;
  events?: unknown;
  event_log?: unknown;
  eventLog?: unknown;
  messages?: unknown;
  traces?: unknown;
  trace_refs?: unknown;
  traceRefs?: unknown;
}

export interface OpenHandsTerminalDecision {
  status: "succeeded" | "failed";
  retryable: boolean;
  eventCursor: string;
  reason?: string;
}

export class OpenHandsCloudAdapter implements ExecutionAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly selectedRepository: string | undefined;
  private readonly eventLogPathTemplate: string | undefined;
  private readonly startTimeoutMs: number;
  private readonly executionTimeoutMs: number;
  private readonly startPollIntervalMs: number;
  private readonly executionPollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: OpenHandsCloudAdapterOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.OPENHANDS_BASE_URL);
    this.apiKey = options.apiKey ?? process.env.OPENHANDS_API_KEY ?? "";
    this.selectedRepository =
      options.selectedRepository ?? process.env.OPENHANDS_SELECTED_REPOSITORY;
    this.eventLogPathTemplate =
      options.eventLogPathTemplate ??
      normalizeOptional(process.env.OPENHANDS_EVENT_LOG_PATH_TEMPLATE);
    this.startTimeoutMs =
      options.startTimeoutMs ?? readNumberEnv("OPENHANDS_START_TIMEOUT_MS", 300_000);
    this.executionTimeoutMs =
      options.executionTimeoutMs ?? readNumberEnv("OPENHANDS_EXECUTION_TIMEOUT_MS", 3_600_000);
    this.startPollIntervalMs =
      options.startPollIntervalMs ?? readNumberEnv("OPENHANDS_START_POLL_INTERVAL_MS", 5_000);
    this.executionPollIntervalMs =
      options.executionPollIntervalMs ??
      readNumberEnv("OPENHANDS_EXECUTION_POLL_INTERVAL_MS", 30_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? sleep;

    if (!this.apiKey) {
      throw new Error(
        "OPENHANDS_API_KEY is required when WORKER_EXECUTION_ADAPTER=openhands-cloud",
      );
    }
  }

  async execute(input: RunExecutionInput): Promise<RunExecutionResult> {
    const selectedRepository =
      this.selectedRepository ?? repositoryNameFromGitUrl(input.repositoryGitUrl);
    const startTask = await this.startConversation(input, selectedRepository);
    const immediateConversationId =
      startTask.app_conversation_id ?? (startTask.status === "READY" ? startTask.id : undefined);
    const conversationId =
      immediateConversationId ?? (await this.waitForConversationReady(startTask.id ?? ""));
    const baseEventLogUri = `${this.baseUrl}/api/v1/app-conversations?ids=${encodeURIComponent(
      conversationId,
    )}`;
    const conversation = {
      provider: "openhands-cloud",
      conversationId,
      eventLogUri: baseEventLogUri,
      eventCursor: "created",
      uiUrl: `${this.baseUrl}/conversations/${conversationId}`,
    };

    const terminalStatus = await this.waitForExecutionTerminal(conversationId);
    const eventLog = await this.fetchConversationEventLog(terminalStatus);
    const decision = mapOpenHandsTerminalStatus(terminalStatus);
    const traces = dedupeOpenHandsTraceRefs([
      ...extractOpenHandsTraceRefs(terminalStatus, input.promptReleaseId),
      ...(eventLog.payload
        ? extractOpenHandsTraceRefsFromPayload(eventLog.payload, input.promptReleaseId)
        : []),
    ]);
    const events = [
      ...(eventLog.payload
        ? summarizeOpenHandsEventLogPayload(eventLog.payload)
        : summarizeOpenHandsConversationEvents(terminalStatus)),
      ...(eventLog.warning ? [eventLog.warning] : []),
      {
        eventType: "openhands.status",
        message:
          decision.status === "succeeded"
            ? `OpenHands Cloud conversation ${conversationId} finished.`
            : `OpenHands Cloud conversation ${conversationId} stopped before success.`,
        payload:
          decision.status === "succeeded"
            ? terminalStatus
            : {
                ...terminalStatus,
                retryable: decision.retryable,
              },
      },
    ];
    if (decision.status === "succeeded") {
      const result: RunExecutionResult = {
        status: "succeeded",
        summary: `OpenHands Cloud completed conversation ${conversationId}.`,
        conversation: {
          ...conversation,
          eventLogUri: eventLog.uri ?? baseEventLogUri,
          eventCursor: decision.eventCursor,
        },
        traces,
        events,
      };
      const nextState = defaultNextStateForRole(input.role);
      if (nextState) {
        result.nextState = nextState;
      }

      return result;
    }

    return {
      status: "failed",
      reason:
        decision.reason ?? `OpenHands Cloud conversation ${conversationId} ended before success.`,
      retryable: decision.retryable,
      conversation: {
        ...conversation,
        eventLogUri: eventLog.uri ?? baseEventLogUri,
        eventCursor: decision.eventCursor,
      },
      traces,
      events,
    };
  }

  private async startConversation(
    input: RunExecutionInput,
    selectedRepository: string,
  ): Promise<StartConversationResponse> {
    const response = await this.request<StartConversationResponse>("/api/v1/app-conversations", {
      method: "POST",
      body: JSON.stringify({
        initial_message: {
          content: [
            {
              type: "text",
              text: buildInitialMessage(input),
            },
          ],
        },
        selected_repository: selectedRepository,
      }),
    });

    if (!response.id && !response.app_conversation_id) {
      throw new Error("OpenHands Cloud did not return a start task id or conversation id");
    }

    return response;
  }

  private async waitForConversationReady(startTaskId: string): Promise<string> {
    if (!startTaskId) {
      throw new Error("OpenHands Cloud start task id is required before polling readiness");
    }

    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() <= deadline) {
      const tasksResponse = await this.request<unknown>(
        `/api/v1/app-conversations/start-tasks?ids=${encodeURIComponent(startTaskId)}`,
      );
      const tasks = parseOpenHandsList<StartTaskStatus>(tasksResponse);
      const task = tasks[0];
      if (
        task?.status &&
        normalizeOpenHandsStatus(task.status) === "ready" &&
        task.app_conversation_id
      ) {
        return task.app_conversation_id;
      }

      if (
        task?.status &&
        ["error", "failed", "failure"].includes(normalizeOpenHandsStatus(task.status))
      ) {
        throw new Error(`OpenHands Cloud conversation start failed: ${task.error ?? "unknown"}`);
      }

      await this.sleepImpl(this.startPollIntervalMs);
    }

    throw new Error("Timed out waiting for OpenHands Cloud conversation to become ready");
  }

  private async waitForExecutionTerminal(conversationId: string): Promise<ConversationStatus> {
    const deadline = Date.now() + this.executionTimeoutMs;
    while (Date.now() <= deadline) {
      const conversationsResponse = await this.request<unknown>(
        `/api/v1/app-conversations?ids=${encodeURIComponent(conversationId)}`,
      );
      const conversations = parseOpenHandsList<ConversationStatus>(conversationsResponse);
      const conversation = conversations[0];
      if (!conversation) {
        await this.sleepImpl(this.executionPollIntervalMs);
        continue;
      }

      const sandboxStatus = normalizeOpenHandsStatus(conversation.sandbox_status ?? "");
      const executionStatus = normalizeOpenHandsStatus(conversation.execution_status ?? "");
      if (["error", "missing", "lost", "unavailable", "terminated"].includes(sandboxStatus)) {
        return conversation;
      }

      if (
        [
          "finished",
          "completed",
          "complete",
          "success",
          "succeeded",
          "error",
          "failed",
          "failure",
          "crashed",
          "timeout",
          "timed_out",
          "stuck",
          "blocked",
          "paused",
          "needs_attention",
          "requires_attention",
          "waiting_for_confirmation",
          "awaiting_confirmation",
          "requires_confirmation",
          "confirmation_required",
          "waiting_for_user",
          "awaiting_user",
          "user_input_required",
          "cancelled",
          "canceled",
          "aborted",
          "stopped",
        ].includes(executionStatus)
      ) {
        return conversation;
      }

      await this.sleepImpl(this.executionPollIntervalMs);
    }

    throw new Error("Timed out waiting for OpenHands Cloud conversation execution to finish");
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.requestUrl(`${this.baseUrl}${path}`, init);
  }

  private async requestUrl<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenHands Cloud API ${response.status}: ${text}`);
    }

    return (await response.json()) as T;
  }

  private async fetchConversationEventLog(
    conversation: ConversationStatus,
  ): Promise<{ uri?: string; payload?: unknown; warning?: RunExecutionEvent }> {
    const eventLogUri = resolveOpenHandsEventLogUri(
      conversation,
      this.baseUrl,
      this.eventLogPathTemplate,
    );
    if (!eventLogUri) {
      return {};
    }

    try {
      const payload = await this.requestUrl<unknown>(eventLogUri);
      return {
        uri: eventLogUri,
        payload,
      };
    } catch (error) {
      return {
        uri: eventLogUri,
        warning: {
          eventType: "openhands.event_log_warning",
          message: "OpenHands event log fetch failed; using conversation payload summary.",
          payload: {
            eventLogUri,
            reason: error instanceof Error ? truncateString(error.message, 500) : String(error),
          },
        },
      };
    }
  }
}

export function createOpenHandsCloudAdapter(): ExecutionAdapter {
  return new OpenHandsCloudAdapter();
}

export function parseOpenHandsList<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }

  if (isRecord(value)) {
    if (Array.isArray(value.results)) {
      return value.results as T[];
    }

    if (Array.isArray(value.data)) {
      return value.data as T[];
    }

    return [value as T];
  }

  return [];
}

export function mapOpenHandsTerminalStatus(status: ConversationStatus): OpenHandsTerminalDecision {
  const rawExecution = status.execution_status ?? "unknown";
  const rawSandbox = status.sandbox_status ?? "unknown";
  const execution = normalizeOpenHandsStatus(rawExecution);
  const sandbox = normalizeOpenHandsStatus(rawSandbox);
  const eventCursor = status.execution_status ?? status.sandbox_status ?? "unknown";

  if (["finished", "completed", "complete", "success", "succeeded"].includes(execution)) {
    return {
      status: "succeeded",
      retryable: false,
      eventCursor,
    };
  }

  if (
    [
      "waiting_for_confirmation",
      "awaiting_confirmation",
      "requires_confirmation",
      "confirmation_required",
      "waiting_for_user",
      "awaiting_user",
      "user_input_required",
    ].includes(execution)
  ) {
    return {
      status: "failed",
      retryable: false,
      eventCursor,
      reason: `OpenHands Cloud conversation ${status.id} is waiting for human confirmation.`,
    };
  }

  if (["stuck", "blocked", "paused", "needs_attention", "requires_attention"].includes(execution)) {
    return {
      status: "failed",
      retryable: false,
      eventCursor,
      reason: `OpenHands Cloud conversation ${status.id} is stuck and requires review.`,
    };
  }

  if (["error", "missing", "lost", "unavailable", "terminated"].includes(sandbox)) {
    return {
      status: "failed",
      retryable: true,
      eventCursor,
      reason: `OpenHands Cloud sandbox ${rawSandbox} for conversation ${status.id}.`,
    };
  }

  if (["error", "failed", "failure", "crashed", "timeout", "timed_out"].includes(execution)) {
    return {
      status: "failed",
      retryable: true,
      eventCursor,
      reason: `OpenHands Cloud conversation ${status.id} ended with sandbox=${rawSandbox} execution=${rawExecution}.`,
    };
  }

  if (["cancelled", "canceled", "aborted", "stopped"].includes(execution)) {
    return {
      status: "failed",
      retryable: false,
      eventCursor,
      reason: `OpenHands Cloud conversation ${status.id} ended with sandbox=${rawSandbox} execution=${rawExecution}.`,
    };
  }

  return {
    status: "failed",
    retryable: false,
    eventCursor,
    reason: `OpenHands Cloud conversation ${status.id} ended with sandbox=${rawSandbox} execution=${rawExecution}.`,
  };
}

function normalizeOpenHandsStatus(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function summarizeOpenHandsConversationEvents(
  conversation: ConversationStatus,
  limit = 10,
): RunExecutionEvent[] {
  const rawEvents = firstOpenHandsEventArray(
    conversation.events,
    conversation.event_log,
    conversation.eventLog,
    conversation.messages,
  );
  if (!rawEvents.length) {
    return [];
  }

  return rawEvents.slice(-limit).map((event) => summarizeOpenHandsEvent(event));
}

export function summarizeOpenHandsEventLogPayload(
  payload: unknown,
  limit = 10,
): RunExecutionEvent[] {
  const rawEvents = firstOpenHandsEventArray(payload);
  return rawEvents.slice(-limit).map((event) => summarizeOpenHandsEvent(event));
}

export function extractOpenHandsTraceRefs(
  conversation: ConversationStatus,
  promptReleaseId?: string,
): RunTraceRef[] {
  const candidates = [
    ...firstOpenHandsEventArray(
      conversation.traces,
      conversation.trace_refs,
      conversation.traceRefs,
    ),
    ...firstOpenHandsEventArray(
      conversation.events,
      conversation.event_log,
      conversation.eventLog,
      conversation.messages,
    ),
  ];
  const traces = new Map<string, RunTraceRef>();

  for (const candidate of candidates) {
    const trace = traceRefFromOpenHandsPayload(candidate, promptReleaseId);
    if (trace) {
      traces.set(`${trace.provider}:${trace.traceId}:${trace.generationId ?? ""}`, trace);
    }
  }

  return [...traces.values()];
}

export function extractOpenHandsTraceRefsFromPayload(
  payload: unknown,
  promptReleaseId?: string,
): RunTraceRef[] {
  const traces = new Map<string, RunTraceRef>();
  for (const candidate of firstOpenHandsEventArray(payload)) {
    const trace = traceRefFromOpenHandsPayload(candidate, promptReleaseId);
    if (trace) {
      traces.set(`${trace.provider}:${trace.traceId}:${trace.generationId ?? ""}`, trace);
    }
  }

  return [...traces.values()];
}

function buildInitialMessage(input: RunExecutionInput): string {
  return [
    `Task: ${input.identifier}`,
    `Repository: ${input.repositorySlug}`,
    `Run: ${input.runId}`,
    "",
    input.renderedPrompt ?? "请根据任务上下文完成本次开发任务。",
  ].join("\n");
}

function firstOpenHandsEventArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    const events = extractOpenHandsEventArray(value);
    if (events.length) {
      return events;
    }
  }

  return [];
}

function dedupeOpenHandsTraceRefs(traces: readonly RunTraceRef[]): RunTraceRef[] {
  const deduped = new Map<string, RunTraceRef>();
  for (const trace of traces) {
    deduped.set(`${trace.provider}:${trace.traceId}:${trace.generationId ?? ""}`, trace);
  }

  return [...deduped.values()];
}

function resolveOpenHandsEventLogUri(
  conversation: ConversationStatus,
  baseUrl: string,
  pathTemplate?: string,
): string | undefined {
  const candidate =
    conversation.event_log_uri ??
    conversation.eventLogUri ??
    conversation.event_log_url ??
    conversation.eventLogUrl ??
    conversation.events_url ??
    conversation.eventsUrl ??
    conversation.log_url ??
    conversation.logUrl;
  if (candidate) {
    const resolvedCandidate = resolveSameOriginUrl(candidate, baseUrl);
    if (resolvedCandidate) {
      return resolvedCandidate;
    }
  }

  if (!pathTemplate) {
    return undefined;
  }

  const templatedPath = pathTemplate
    .replaceAll("{conversationId}", encodeURIComponent(conversation.id))
    .replaceAll(":conversationId", encodeURIComponent(conversation.id));
  return resolveSameOriginUrl(templatedPath, baseUrl);
}

function resolveSameOriginUrl(candidate: string, baseUrl: string): string | undefined {
  const base = new URL(baseUrl);
  const resolved = new URL(candidate, `${baseUrl}/`);
  if (resolved.origin !== base.origin) {
    return undefined;
  }

  return resolved.toString();
}

function extractOpenHandsEventArray(value: unknown, depth = 0): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (!isRecord(value) || depth > 3) {
    return [];
  }

  for (const key of [
    "events",
    "event_log",
    "eventLog",
    "messages",
    "items",
    "results",
    "data",
    "logs",
  ]) {
    const nested = extractOpenHandsEventArray(value[key], depth + 1);
    if (nested.length) {
      return nested;
    }
  }

  return [];
}

function summarizeOpenHandsEvent(event: unknown): RunExecutionEvent {
  if (!isRecord(event)) {
    return {
      eventType: "openhands.event",
      message: summarizeSensitiveText(String(event), 240),
      payload: { value: summarizeSensitiveText(String(event), 2_000) },
    };
  }

  const eventType = classifyOpenHandsEvent(event);
  const message = eventMessage(event, eventType);
  return {
    eventType,
    message,
    payload: sanitizeOpenHandsEventPayload(event),
  };
}

function classifyOpenHandsEvent(event: Record<string, unknown>): string {
  const text = [
    stringField(event, "type"),
    stringField(event, "event_type"),
    stringField(event, "source"),
    stringField(event, "role"),
    stringField(event, "action"),
    stringField(event, "name"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (stringField(event, "command") || text.includes("shell") || text.includes("terminal")) {
    return "openhands.shell";
  }

  if (
    text.includes("file") ||
    text.includes("edit") ||
    text.includes("patch") ||
    text.includes("write") ||
    text.includes("read") ||
    stringField(event, "path") ||
    stringField(event, "file") ||
    stringField(event, "file_path") ||
    stringField(event, "filename") ||
    stringField(event, "diff")
  ) {
    return "openhands.file_operation";
  }

  if (text.includes("tool") || text.includes("action") || stringField(event, "tool_call_id")) {
    return "openhands.tool_call";
  }

  if (
    text.includes("llm") ||
    text.includes("generation") ||
    stringField(event, "prompt") ||
    stringField(event, "response") ||
    stringField(event, "completion") ||
    stringField(event, "model") ||
    stringField(event, "model_name") ||
    stringField(event, "trace_id") ||
    stringField(event, "traceId") ||
    stringField(event, "generation_id") ||
    stringField(event, "generationId")
  ) {
    return "openhands.llm_generation";
  }

  if (
    text.includes("message") ||
    text.includes("assistant") ||
    text.includes("agent") ||
    stringField(event, "content") ||
    stringField(event, "message")
  ) {
    return "openhands.agent_message";
  }

  return "openhands.event";
}

function eventMessage(event: Record<string, unknown>, eventType: string): string {
  if (eventType === "openhands.shell") {
    const shellMessage = stringField(event, "command") ?? stringField(event, "message");
    if (shellMessage) {
      return summarizeSensitiveText(shellMessage, 240);
    }
  }

  if (eventType === "openhands.tool_call") {
    const toolMessage =
      stringField(event, "action") ?? stringField(event, "name") ?? stringField(event, "message");
    if (toolMessage) {
      return summarizeSensitiveText(toolMessage, 240);
    }
  }

  if (eventType === "openhands.file_operation") {
    const fileMessage = [
      stringField(event, "action") ?? stringField(event, "type") ?? stringField(event, "name"),
      stringField(event, "path") ??
        stringField(event, "file_path") ??
        stringField(event, "file") ??
        stringField(event, "filename") ??
        stringField(event, "name"),
    ]
      .filter(Boolean)
      .join(" ");
    if (fileMessage) {
      return summarizeSensitiveText(fileMessage, 240);
    }
  }

  if (eventType === "openhands.llm_generation") {
    const model = stringField(event, "model") ?? stringField(event, "model_name");
    const output =
      stringField(event, "response") ??
      stringField(event, "output") ??
      stringField(event, "completion") ??
      stringField(event, "message") ??
      stringField(event, "content");
    return summarizeSensitiveText(
      [model ? `model=${model}` : "", output ?? "llm generation"].filter(Boolean).join(" "),
      240,
    );
  }

  const contentText = textFromContentParts(event.content);
  const explicit =
    stringField(event, "message") ??
    stringField(event, "content") ??
    contentText ??
    stringField(event, "thought") ??
    stringField(event, "command") ??
    stringField(event, "action") ??
    stringField(event, "type") ??
    eventType;

  return summarizeSensitiveText(explicit, 240);
}

function sanitizeOpenHandsEventPayload(event: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of [
    "id",
    "timestamp",
    "created_at",
    "type",
    "event_type",
    "source",
    "role",
    "action",
    "name",
    "command",
    "exit_code",
    "path",
    "file",
    "file_path",
    "filename",
    "diff",
    "tool_call_id",
    "trace_id",
    "traceId",
    "generation_id",
    "generationId",
    "model",
    "model_name",
    "prompt",
    "input",
    "response",
    "output",
    "completion",
    "input_tokens",
    "inputTokens",
    "output_tokens",
    "outputTokens",
    "cost",
    "cost_usd",
    "costUsd",
    "latency_ms",
    "latencyMs",
    "ui_url",
    "uiUrl",
    "trace_url",
    "traceUrl",
    "message",
    "content",
  ]) {
    const value = event[key];
    if (typeof value === "number" || typeof value === "boolean") {
      payload[key] = value;
    } else {
      const textValue = textFromOpenHandsValue(value);
      if (textValue) {
        payload[key] = summarizeSensitiveText(textValue, 2_000);
      }
    }
  }

  return payload;
}

function traceRefFromOpenHandsPayload(
  value: unknown,
  promptReleaseId?: string,
): RunTraceRef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const traceId =
    stringField(value, "trace_id") ??
    stringField(value, "traceId") ??
    stringField(value, "langfuse_trace_id") ??
    stringField(value, "langfuseTraceId");
  if (!traceId) {
    return undefined;
  }

  const trace: RunTraceRef = {
    provider:
      stringField(value, "trace_provider") ??
      stringField(value, "provider") ??
      "openhands-langfuse",
    traceId,
  };

  const generationId =
    stringField(value, "generation_id") ??
    stringField(value, "generationId") ??
    stringField(value, "observation_id") ??
    stringField(value, "observationId");
  if (generationId) {
    trace.generationId = generationId;
  }

  const model = stringField(value, "model") ?? stringField(value, "model_name");
  if (model) {
    trace.model = model;
  }

  if (promptReleaseId) {
    trace.promptReleaseId = promptReleaseId;
  }

  const inputTokens = numberField(value, "input_tokens") ?? numberField(value, "inputTokens");
  if (inputTokens !== undefined) {
    trace.inputTokens = inputTokens;
  }

  const outputTokens = numberField(value, "output_tokens") ?? numberField(value, "outputTokens");
  if (outputTokens !== undefined) {
    trace.outputTokens = outputTokens;
  }

  const costUsd = stringField(value, "cost_usd") ?? stringField(value, "costUsd");
  if (costUsd) {
    trace.costUsd = costUsd;
  } else {
    const numericCost = numberField(value, "cost");
    if (numericCost !== undefined) {
      trace.costUsd = numericCost.toFixed(6);
    }
  }

  const latencyMs = numberField(value, "latency_ms") ?? numberField(value, "latencyMs");
  if (latencyMs !== undefined) {
    trace.latencyMs = latencyMs;
  }

  const uiUrl =
    stringField(value, "ui_url") ??
    stringField(value, "uiUrl") ??
    stringField(value, "trace_url") ??
    stringField(value, "traceUrl");
  if (uiUrl) {
    trace.uiUrl = uiUrl;
  }

  return trace;
}

function stringField(event: Record<string, unknown>, key: string): string | undefined {
  const value = event[key];
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  const contentText = textFromOpenHandsValue(value);
  return contentText.trim() ? contentText : undefined;
}

function numberField(event: Record<string, unknown>, key: string): number | undefined {
  const value = event[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function textFromContentParts(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (isRecord(part)) {
        const text = part.text;
        if (typeof text === "string") {
          return text;
        }

        const content = part.content;
        if (typeof content === "string") {
          return content;
        }
      }

      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function textFromOpenHandsValue(value: unknown, depth = 0): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (depth > 4) {
    return "";
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => textFromOpenHandsValue(part, depth + 1))
      .filter(Boolean)
      .join(" ");
  }

  if (!isRecord(value)) {
    return "";
  }

  for (const key of [
    "text",
    "content",
    "message",
    "prompt",
    "input",
    "response",
    "output",
    "completion",
    "value",
  ]) {
    const text = textFromOpenHandsValue(value[key], depth + 1);
    if (text) {
      return text;
    }
  }

  for (const key of ["messages", "choices", "items", "results", "data"]) {
    const text = textFromOpenHandsValue(value[key], depth + 1);
    if (text) {
      return text;
    }
  }

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateString(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function summarizeSensitiveText(value: string, maxLength: number): string {
  return truncateString(redactSensitiveText(value.replace(/\s+/g, " ").trim()), maxLength);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /\b([A-Z0-9_-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD))\s*[:=]\s*["']?([^\s"',;]+)/gi,
      "$1=<redacted>",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer <redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-<redacted>");
}

function normalizeBaseUrl(value: string | undefined): string {
  return (value?.trim() || "https://app.all-hands.dev").replace(/\/+$/, "");
}

function readNumberEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function repositoryNameFromGitUrl(gitUrl: string): string {
  const trimmed = gitUrl.trim().replace(/\.git$/, "");
  const sshMatch = /^git@[^:]+:([^/]+\/.+)$/.exec(trimmed);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }

  try {
    const url = new URL(trimmed);
    return url.pathname.replace(/^\/+/, "");
  } catch {
    return trimmed;
  }
}
