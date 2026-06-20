import { beforeEach, describe, expect, it, vi } from "vitest";
import { estimatePromptTokens, LangfuseTelemetry } from "../src/telemetry/langfuse";

const mocks = vi.hoisted(() => {
  const sdkStart = vi.fn();
  const sdkShutdown = vi.fn();
  const observationEnd = vi.fn();
  const observationUpdate = vi.fn(() => ({ end: observationEnd }));
  const startObservation = vi.fn(() => ({
    id: "generation-1",
    traceId: "trace-1",
    update: observationUpdate,
    end: observationEnd,
  }));

  return {
    sdkStart,
    sdkShutdown,
    observationUpdate,
    observationEnd,
    startObservation,
  };
});

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: vi.fn().mockImplementation(function NodeSDK() {
    return {
      start: mocks.sdkStart,
      shutdown: mocks.sdkShutdown,
    };
  }),
}));

vi.mock("@langfuse/otel", () => ({
  LangfuseSpanProcessor: vi.fn().mockImplementation(function LangfuseSpanProcessor(
    this: { config?: unknown },
    config: unknown,
  ) {
    this.config = config;
  }),
}));

vi.mock("@langfuse/tracing", () => ({
  startObservation: mocks.startObservation,
}));

describe("LangfuseTelemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not create trace refs while disabled", () => {
    const telemetry = new LangfuseTelemetry({
      enabled: false,
      environment: "dev",
    });
    const observation = telemetry.startRun({
      runId: "run-1",
      taskId: "task-1",
      identifier: "TOK-1",
      repositorySlug: "crs-src",
      role: "development",
      workerId: "worker-test",
      executionAdapter: "mock-openhands",
      renderedPrompt: "实现任务",
    });

    expect(observation.complete({ status: "succeeded", summary: "ok" })).toBeUndefined();
    expect(mocks.startObservation).not.toHaveBeenCalled();
  });

  it("estimates prompt tokens with a stable lower bound", () => {
    expect(estimatePromptTokens(undefined)).toBeUndefined();
    expect(estimatePromptTokens("")).toBeUndefined();
    expect(estimatePromptTokens("abcd")).toBe(1);
    expect(estimatePromptTokens("abcde")).toBe(2);
  });

  it("records rendered prompt and completion output in the Langfuse observation", async () => {
    const telemetry = new LangfuseTelemetry({
      enabled: true,
      environment: "dev",
      baseUrl: "https://langfuse.example.com",
      projectId: "project-1",
      publicKey: "pk-test",
      secretKey: "sk-test",
    });

    const observation = telemetry.startRun({
      runId: "run-1",
      taskId: "task-1",
      identifier: "TOK-1",
      repositorySlug: "crs-src",
      role: "development",
      workerId: "worker-test",
      executionAdapter: "openhands-cloud",
      promptReleaseId: "prompt-release-1",
      model: "openhands-cloud",
      renderedPrompt: "完整 prompt 内容",
    });

    const trace = observation.complete({
      status: "succeeded",
      summary: "实现完成",
      outputTokens: 11,
      costUsd: "0.001000",
      latencyMs: 25,
    });
    await telemetry.shutdown();

    expect(mocks.startObservation).toHaveBeenCalledWith(
      "agent-run",
      expect.objectContaining({
        input: {
          task: "TOK-1",
          role: "development",
          repository: "crs-src",
          promptReleaseId: "prompt-release-1",
          prompt: "完整 prompt 内容",
        },
      }),
      { asType: "agent" },
    );
    expect(mocks.observationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        output: {
          status: "succeeded",
          summary: "实现完成",
        },
        metadata: expect.objectContaining({
          promptReleaseId: "prompt-release-1",
          model: "openhands-cloud",
          latencyMs: 25,
        }),
      }),
    );
    expect(mocks.observationEnd).toHaveBeenCalled();
    expect(mocks.sdkStart).toHaveBeenCalled();
    expect(mocks.sdkShutdown).toHaveBeenCalled();
    expect(trace).toEqual(
      expect.objectContaining({
        provider: "langfuse",
        traceId: "trace-1",
        generationId: "generation-1",
        promptReleaseId: "prompt-release-1",
        model: "openhands-cloud",
        inputTokens: 3,
        outputTokens: 11,
        costUsd: "0.001000",
        latencyMs: 25,
        uiUrl: "https://langfuse.example.com/project/project-1/traces/trace-1",
      }),
    );
  });

  it("records OpenHands event summaries and trace refs in the Langfuse output", async () => {
    const telemetry = new LangfuseTelemetry({
      enabled: true,
      environment: "dev",
      baseUrl: "https://langfuse.example.com",
      projectId: "project-1",
      publicKey: "pk-test",
      secretKey: "sk-test",
    });

    const observation = telemetry.startRun({
      runId: "run-1",
      taskId: "task-1",
      identifier: "TOK-1",
      repositorySlug: "crs-src",
      role: "development",
      workerId: "worker-test",
      executionAdapter: "openhands-cloud",
      promptReleaseId: "prompt-release-1",
      renderedPrompt: "完整 prompt 内容",
    });

    observation.complete({
      status: "succeeded",
      summary: "实现完成",
      events: [
        {
          eventType: "openhands.agent_message",
          message: "调用模型完成设计，api_key=secret-value",
          payload: {
            content: "Bearer secret-token",
            nested: { password: "secret-password" },
          },
        },
      ],
      traceRefs: [
        {
          provider: "openhands-langfuse",
          traceId: "external-trace-1",
          generationId: "generation-2",
          promptReleaseId: "prompt-release-1",
          model: "gpt-5.5",
          inputTokens: 10,
          outputTokens: 20,
          costUsd: "0.010000",
          latencyMs: 30,
          uiUrl: "https://langfuse.example.com/project/project-1/traces/external-trace-1",
        },
      ],
    });
    await telemetry.shutdown();

    expect(mocks.observationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({
          status: "succeeded",
          events: [
            {
              eventType: "openhands.agent_message",
              message: "调用模型完成设计，api_key=***",
              payload: {
                content: "Bearer secret-token",
                nested: { password: "***" },
              },
            },
          ],
          traceRefs: [
            {
              provider: "openhands-langfuse",
              traceId: "external-trace-1",
              generationId: "generation-2",
              promptReleaseId: "prompt-release-1",
              model: "gpt-5.5",
              inputTokens: 10,
              outputTokens: 20,
              costUsd: "0.010000",
              latencyMs: 30,
              uiUrl: "https://langfuse.example.com/project/project-1/traces/external-trace-1",
            },
          ],
        }),
      }),
    );
  });
});
