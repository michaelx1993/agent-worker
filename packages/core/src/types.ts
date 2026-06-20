export type WorkflowState =
  | "Backlog"
  | "Todo"
  | "Development"
  | "Code Review"
  | "Human Review"
  | "In Merge"
  | "Merged"
  | "Release Version"
  | "Released"
  | "Deployment"
  | "Deployed"
  | "Blocked"
  | "Done"
  | "Canceled"
  | "Duplicate";

export type AgentRole =
  | "intake"
  | "development"
  | "code_review"
  | "merge"
  | "release"
  | "deploy"
  | "human_gate"
  | "terminal";

export type PromptScope = "global" | "team" | "project" | "repo" | "role" | "agent";

export interface TaskLabel {
  name: string;
}

export interface RepositoryRef {
  id: string;
  slug: string;
  status: "active" | "archived";
}

export interface TaskSnapshot {
  id: string;
  identifier: string;
  title: string;
  state: WorkflowState;
  repositoryId?: string;
  labels?: readonly (string | TaskLabel)[];
  blocked?: boolean;
  humanRequired?: boolean;
  priority?: number | null;
  estimatedCostUsd?: number | null;
  updatedAt?: Date;
}

export interface ActiveRunSnapshot {
  taskId: string;
  repositoryId?: string;
  role?: AgentRole;
  status: "queued" | "claimed" | "running" | "succeeded" | "blocked" | "failed" | "canceled";
  leaseExpiresAt?: Date;
}

export interface DispatchConcurrencyPolicy {
  maxActiveRunsPerRepository?: number;
  maxActiveRunsPerRole?: number;
  maxActiveRunsPerAgent?: number;
}

export interface DispatchBudgetPolicy {
  maxEstimatedCostUsdPerRun?: number;
}

export interface DispatchDecision {
  dispatchable: boolean;
  role?: AgentRole;
  reasons: string[];
}

export interface PromptComponent {
  id: string;
  scope: PromptScope;
  name: string;
  version: number;
  content: string;
  order?: number;
}

export interface PromptRenderInput {
  components: readonly PromptComponent[];
  taskContext: string;
  commentsAndWorkpad?: string;
  runtimeConstraints?: string;
}

export interface PromptRenderResult {
  content: string;
  componentIds: string[];
}
