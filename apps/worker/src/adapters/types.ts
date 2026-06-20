import type { AgentRole } from "@agent-control-plane/core";

export interface RunExecutionInput {
  runId: string;
  taskId: string;
  identifier: string;
  repositoryId: string;
  repositorySlug: string;
  repositoryGitUrl: string;
  workspacePath?: string;
  workspaceStrategy?: string;
  workspaceBaseRef?: string;
  workspaceHeadRef?: string;
  role: AgentRole;
  leaseOwner: string;
  promptReleaseId?: string;
  renderedPrompt?: string;
  previousConversation?: RunConversationRef;
}

export interface RunConversationRef {
  provider: string;
  conversationId: string;
  eventLogUri?: string;
  eventCursor?: string;
  uiUrl?: string;
}

export interface RunTraceRef {
  provider: string;
  traceId: string;
  generationId?: string;
  model?: string;
  promptReleaseId?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: string;
  latencyMs?: number;
  uiUrl?: string;
}

export interface RunExecutionEvent {
  eventType: string;
  message: string;
  payload?: unknown;
}

export type RunExecutionResult =
  | {
      status: "succeeded";
      summary: string;
      nextState?: string;
      conversation?: RunConversationRef;
      traces?: RunTraceRef[];
      events?: RunExecutionEvent[];
    }
  | {
      status: "failed";
      reason: string;
      retryable: boolean;
      conversation?: RunConversationRef;
      traces?: RunTraceRef[];
      events?: RunExecutionEvent[];
    };

export interface ExecutionAdapter {
  execute(input: RunExecutionInput): Promise<RunExecutionResult>;
  dispose?(): Promise<void> | void;
}
