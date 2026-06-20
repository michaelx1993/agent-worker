import type { AgentRole } from "@agent-control-plane/core";
import { OpenHandsCloudAdapter } from "./adapters/openhands-cloud.js";

const allowedRoles = new Set<AgentRole>([
  "intake",
  "development",
  "code_review",
  "merge",
  "release",
  "deploy",
  "human_gate",
  "terminal",
]);

async function main() {
  const role = parseRole(process.env.OPENHANDS_ADAPTER_SMOKE_ROLE ?? "development");
  const adapter = new OpenHandsCloudAdapter({
    startTimeoutMs: parsePositiveInt(process.env.OPENHANDS_ADAPTER_SMOKE_START_TIMEOUT_MS, 60_000),
    executionTimeoutMs: parsePositiveInt(
      process.env.OPENHANDS_ADAPTER_SMOKE_EXECUTION_TIMEOUT_MS,
      300_000,
    ),
    startPollIntervalMs: parsePositiveInt(
      process.env.OPENHANDS_ADAPTER_SMOKE_START_POLL_INTERVAL_MS,
      2_000,
    ),
    executionPollIntervalMs: parsePositiveInt(
      process.env.OPENHANDS_ADAPTER_SMOKE_EXECUTION_POLL_INTERVAL_MS,
      5_000,
    ),
  });

  const result = await adapter.execute({
    runId: `openhands-adapter-smoke-${Date.now()}`,
    taskId: "openhands-adapter-smoke-task",
    identifier: process.env.OPENHANDS_ADAPTER_SMOKE_IDENTIFIER ?? "OPENHANDS-SMOKE",
    repositoryId: "openhands-adapter-smoke-repo",
    repositorySlug: process.env.OPENHANDS_ADAPTER_SMOKE_REPOSITORY_SLUG ?? "aiworkspace",
    repositoryGitUrl:
      process.env.OPENHANDS_ADAPTER_SMOKE_REPOSITORY_GIT_URL ??
      "git@github.com:michaelx1993/aiworkspace.git",
    role,
    leaseOwner: "openhands-adapter-smoke",
    renderedPrompt:
      process.env.OPENHANDS_ADAPTER_SMOKE_PROMPT ??
      "这是 Agent Control Plane 的 OpenHands adapter smoke。请返回一条简短确认，不要修改仓库。",
  });

  if (result.status !== "succeeded") {
    console.error("openhands_adapter_smoke=failed");
    console.error(`reason=${result.reason}`);
    console.error(`retryable=${result.retryable}`);
    process.exit(1);
  }

  if (!result.conversation?.conversationId) {
    throw new Error("OpenHands adapter smoke succeeded without conversation id");
  }

  console.log("openhands_adapter_smoke=passed");
  console.log(`conversation_id=${result.conversation.conversationId}`);
  if (result.conversation.uiUrl) {
    console.log(`ui_url=${result.conversation.uiUrl}`);
  }
  if (result.nextState) {
    console.log(`next_state=${result.nextState}`);
  }
  console.log(`events=${result.events?.length ?? 0}`);
}

function parseRole(value: string): AgentRole {
  if (allowedRoles.has(value as AgentRole)) {
    return value as AgentRole;
  }

  throw new Error(`Unsupported OPENHANDS_ADAPTER_SMOKE_ROLE: ${value}`);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

main().catch((error: unknown) => {
  console.error("openhands_adapter_smoke=failed");
  console.error(`error=${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
