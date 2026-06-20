import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  startObservation,
  type LangfuseAgent,
  type LangfuseSpanAttributes,
} from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { RunExecutionEvent, RunTraceRef } from "../adapters/types.js";
import type { WorkerLangfuseConfig } from "../config.js";

export interface RunTelemetryInput {
  runId: string;
  taskId: string;
  identifier: string;
  repositorySlug: string;
  role: string;
  workerId: string;
  executionAdapter: string;
  promptReleaseId?: string;
  model?: string;
  renderedPrompt?: string;
}

export interface RunTelemetryCompletion {
  status: "succeeded" | "failed";
  summary?: string;
  reason?: string;
  events?: readonly RunExecutionEvent[];
  traceRefs?: readonly RunTraceRef[];
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: string;
  latencyMs?: number;
}

export interface RunTelemetryObservation {
  complete(completion: RunTelemetryCompletion): RunTraceRef | undefined;
}

export class LangfuseTelemetry {
  private readonly config: WorkerLangfuseConfig;
  private sdk: NodeSDK | undefined;
  private started = false;

  constructor(config: WorkerLangfuseConfig) {
    this.config = config;
  }

  start(): void {
    if (!this.config.enabled || this.started) {
      return;
    }

    const processorConfig = {
      ...(this.config.publicKey ? { publicKey: this.config.publicKey } : {}),
      ...(this.config.secretKey ? { secretKey: this.config.secretKey } : {}),
      ...(this.config.baseUrl ? { baseUrl: this.config.baseUrl } : {}),
      environment: this.config.environment,
      ...(this.config.release ? { release: this.config.release } : {}),
      exportMode: "immediate" as const,
      mask: ({ data }: { data: unknown }) => maskSecrets(data),
    };
    this.sdk = new NodeSDK({
      spanProcessors: [new LangfuseSpanProcessor(processorConfig)],
    });
    this.sdk.start();
    this.started = true;
  }

  startRun(input: RunTelemetryInput): RunTelemetryObservation {
    if (!this.config.enabled) {
      return disabledObservation;
    }

    this.start();
    const startedAt = Date.now();
    const observation = startObservation(
      "agent-run",
      {
        input: {
          task: input.identifier,
          role: input.role,
          repository: input.repositorySlug,
          promptReleaseId: input.promptReleaseId,
          prompt: input.renderedPrompt,
        },
        metadata: {
          runId: input.runId,
          taskId: input.taskId,
          workerId: input.workerId,
          executionAdapter: input.executionAdapter,
          renderedPromptChars: input.renderedPrompt?.length ?? 0,
        },
        environment: this.config.environment,
      },
      { asType: "agent" },
    );

    return {
      complete: (completion) =>
        completeRunObservation(
          observation,
          input,
          completion,
          Date.now() - startedAt,
          this.config.baseUrl,
          this.config.projectId,
        ),
    };
  }

  async shutdown(): Promise<void> {
    if (!this.sdk) {
      return;
    }

    await this.sdk.shutdown();
    this.sdk = undefined;
    this.started = false;
  }
}

export function estimatePromptTokens(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  return Math.max(1, Math.ceil(value.length / 4));
}

function completeRunObservation(
  observation: LangfuseAgent,
  input: RunTelemetryInput,
  completion: RunTelemetryCompletion,
  elapsedMs: number,
  baseUrl: string | undefined,
  projectId: string | undefined,
): RunTraceRef {
  const inputTokens = completion.inputTokens ?? estimatePromptTokens(input.renderedPrompt);
  const outputTokens = completion.outputTokens;
  const attributes: LangfuseSpanAttributes = {
    output: {
      status: completion.status,
      ...(completion.summary ? { summary: completion.summary } : {}),
      ...(completion.reason ? { reason: completion.reason } : {}),
      ...(completion.events?.length ? { events: summarizeRunEvents(completion.events) } : {}),
      ...(completion.traceRefs?.length
        ? { traceRefs: summarizeTraceRefs(completion.traceRefs) }
        : {}),
    },
    metadata: {
      ...(input.promptReleaseId ? { promptReleaseId: input.promptReleaseId } : {}),
      ...(input.model ? { model: input.model } : {}),
      latencyMs: completion.latencyMs ?? elapsedMs,
    },
    level: completion.status === "failed" ? "ERROR" : "DEFAULT",
    ...(completion.reason || completion.summary
      ? { statusMessage: completion.reason ?? completion.summary }
      : {}),
  };
  observation.update(attributes).end();

  const trace: RunTraceRef = {
    provider: "langfuse",
    traceId: observation.traceId,
    generationId: observation.id,
    latencyMs: completion.latencyMs ?? elapsedMs,
  };

  if (input.model) {
    trace.model = input.model;
  }

  if (input.promptReleaseId) {
    trace.promptReleaseId = input.promptReleaseId;
  }

  if (inputTokens !== undefined) {
    trace.inputTokens = inputTokens;
  }

  if (outputTokens !== undefined) {
    trace.outputTokens = outputTokens;
  }

  if (completion.costUsd) {
    trace.costUsd = completion.costUsd;
  }

  const normalizedBaseUrl = baseUrl?.replace(/\/$/, "");
  if (normalizedBaseUrl && projectId) {
    trace.uiUrl = `${normalizedBaseUrl}/project/${projectId}/traces/${observation.traceId}`;
  }

  return trace;
}

function summarizeRunEvents(events: readonly RunExecutionEvent[]) {
  return events.slice(-20).map((event) => ({
    eventType: event.eventType,
    message: maskSecrets(event.message),
    payload: maskSecrets(event.payload),
  }));
}

function summarizeTraceRefs(traces: readonly RunTraceRef[]) {
  return traces.slice(-20).map((trace) => ({
    provider: trace.provider,
    traceId: trace.traceId,
    ...(trace.generationId ? { generationId: trace.generationId } : {}),
    ...(trace.model ? { model: trace.model } : {}),
    ...(trace.promptReleaseId ? { promptReleaseId: trace.promptReleaseId } : {}),
    ...(trace.inputTokens !== undefined ? { inputTokens: trace.inputTokens } : {}),
    ...(trace.outputTokens !== undefined ? { outputTokens: trace.outputTokens } : {}),
    ...(trace.costUsd ? { costUsd: trace.costUsd } : {}),
    ...(trace.latencyMs !== undefined ? { latencyMs: trace.latencyMs } : {}),
    ...(trace.uiUrl ? { uiUrl: trace.uiUrl } : {}),
  }));
}

function maskSecrets(data: unknown): unknown {
  if (typeof data === "string") {
    return data
      .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, "$1***")
      .replace(/(api[_-]?key['"]?\s*[:=]\s*['"]?)[^'"\s]+/gi, "$1***");
  }

  if (Array.isArray(data)) {
    return data.map(maskSecrets);
  }

  if (data && typeof data === "object") {
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        key,
        /secret|token|password|api[_-]?key/i.test(key) ? "***" : maskSecrets(value),
      ]),
    );
  }

  return data;
}

const disabledObservation: RunTelemetryObservation = {
  complete: () => undefined,
};
