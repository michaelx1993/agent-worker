import type { AgentRole } from "@agent-control-plane/core";

const defaultNextStateByRole: Partial<Record<AgentRole, string>> = {
  intake: "Development",
  development: "Code Review",
  code_review: "Human Review",
  merge: "Merged",
  release: "Released",
  deploy: "Deployed",
};

export function defaultNextStateForRole(role: AgentRole): string | undefined {
  return defaultNextStateByRole[role];
}
