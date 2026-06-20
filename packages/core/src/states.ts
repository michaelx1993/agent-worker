import type { AgentRole, WorkflowState } from "./types.js";

export const workflowStates = [
  "Backlog",
  "Todo",
  "Development",
  "Code Review",
  "Human Review",
  "In Merge",
  "Merged",
  "Release Version",
  "Released",
  "Deployment",
  "Deployed",
  "Blocked",
  "Done",
  "Canceled",
  "Duplicate",
] as const satisfies readonly WorkflowState[];

export const automaticStates = [
  "Todo",
  "Development",
  "Code Review",
  "In Merge",
  "Release Version",
  "Deployment",
] as const satisfies readonly WorkflowState[];

export const manualGateStates = [
  "Human Review",
  "Merged",
  "Released",
  "Deployed",
] as const satisfies readonly WorkflowState[];

export const terminalStates = [
  "Done",
  "Canceled",
  "Duplicate",
] as const satisfies readonly WorkflowState[];

const roleByState = {
  Backlog: "terminal",
  Todo: "intake",
  Development: "development",
  "Code Review": "code_review",
  "Human Review": "human_gate",
  "In Merge": "merge",
  Merged: "human_gate",
  "Release Version": "release",
  Released: "human_gate",
  Deployment: "deploy",
  Deployed: "human_gate",
  Blocked: "human_gate",
  Done: "terminal",
  Canceled: "terminal",
  Duplicate: "terminal",
} as const satisfies Record<WorkflowState, AgentRole>;

const transitions: Record<WorkflowState, readonly WorkflowState[]> = {
  Backlog: ["Todo", "Done", "Canceled"],
  Todo: ["Development", "Blocked", "Done", "Canceled"],
  Development: ["Code Review", "Blocked", "Done", "Canceled"],
  "Code Review": ["Human Review", "Development", "Blocked", "Done", "Canceled"],
  "Human Review": ["In Merge", "Development", "Blocked", "Done", "Canceled"],
  "In Merge": ["Merged", "Blocked", "Done", "Canceled"],
  Merged: ["Release Version", "Development", "Done", "Canceled"],
  "Release Version": ["Released", "Blocked", "Done", "Canceled"],
  Released: ["Deployment", "Development", "Done", "Canceled"],
  Deployment: ["Deployed", "Blocked", "Done", "Canceled"],
  Deployed: ["Development", "Done", "Canceled"],
  Blocked: ["Development", "Human Review", "Merged", "Released", "Deployed", "Done", "Canceled"],
  Done: [],
  Canceled: [],
  Duplicate: [],
};

export function isWorkflowState(value: string): value is WorkflowState {
  return (workflowStates as readonly string[]).includes(value);
}

export function isAutomaticState(state: WorkflowState): boolean {
  return (automaticStates as readonly WorkflowState[]).includes(state);
}

export function isManualGateState(state: WorkflowState): boolean {
  return (manualGateStates as readonly WorkflowState[]).includes(state);
}

export function isTerminalState(state: WorkflowState): boolean {
  return (terminalStates as readonly WorkflowState[]).includes(state);
}

export function roleForState(state: WorkflowState): AgentRole {
  return roleByState[state];
}

export function nextStatesFor(state: WorkflowState): readonly WorkflowState[] {
  return transitions[state];
}

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return transitions[from].includes(to);
}
