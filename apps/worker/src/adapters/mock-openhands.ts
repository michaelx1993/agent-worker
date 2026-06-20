import { defaultNextStateForRole } from "../lifecycle.js";
import type {
  ExecutionAdapter,
  RunExecutionInput,
  RunExecutionResult,
  RunTraceRef,
} from "./types.js";

export class MockOpenHandsAdapter implements ExecutionAdapter {
  async execute(input: RunExecutionInput): Promise<RunExecutionResult> {
    const delayMs = readMockDelayMs();
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const nextState = defaultNextStateForRole(input.role);
    const result: RunExecutionResult = {
      status: "succeeded",
      summary: "Mock OpenHands adapter completed run.",
      conversation: {
        provider: "mock-openhands",
        conversationId: `mock-${input.runId}`,
        eventLogUri: `memory://mock-openhands/runs/${input.runId}/events`,
        eventCursor: "completed",
        uiUrl: `http://localhost/mock-openhands/runs/${input.runId}`,
      },
      events: buildMockEvents(input),
      traces: [buildMockTrace(input)],
    };

    if (nextState && result.status === "succeeded") {
      result.nextState = nextState;
    }

    return result;
  }
}

function buildMockEvents(input: RunExecutionInput) {
  return [
    {
      eventType: "openhands.agent_message",
      message: `Mock OpenHands accepted ${input.identifier}.`,
      payload: {
        role: input.role,
        repository: input.repositorySlug,
      },
    },
    {
      eventType: "openhands.tool_call",
      message: "Mock OpenHands inspected workspace context.",
      payload: {
        workspacePath: input.workspacePath ?? null,
        workspaceStrategy: input.workspaceStrategy ?? null,
      },
    },
    {
      eventType: "openhands.shell",
      message: "Mock OpenHands completed validation command.",
      payload: {
        command: "pnpm check",
        exitCode: 0,
      },
    },
  ];
}

export function createMockOpenHandsAdapter(): ExecutionAdapter {
  return new MockOpenHandsAdapter();
}

function readMockDelayMs(): number {
  const parsed = Number.parseInt(process.env.MOCK_OPENHANDS_DELAY_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function buildMockTrace(input: RunExecutionInput): RunTraceRef {
  const trace: RunTraceRef = {
    provider: "mock-langfuse",
    traceId: `trace-${input.runId}`,
    generationId: `generation-${input.runId}`,
    model: "mock-openhands",
    inputTokens: estimateTokens(input.renderedPrompt ?? ""),
    outputTokens: 16,
    costUsd: "0.000000",
    latencyMs: 1,
    uiUrl: `http://localhost/mock-langfuse/traces/trace-${input.runId}`,
  };

  if (input.promptReleaseId) {
    trace.promptReleaseId = input.promptReleaseId;
  }

  return trace;
}
