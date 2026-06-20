import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHttpOnce, type WorkerApiClient } from "./http-runner.js";
import type { WorkerConfig } from "./config.js";
import type { WorkerClaimedRunContract } from "@agent-control-plane/core";
import type { ExecutionAdapter } from "./adapters/types.js";

interface SmokeCalls {
  register: number;
  claim: number;
  heartbeat: number;
  events: number;
  progress: number;
  artifacts: number;
  complete: number;
  fail: number;
}

async function main() {
  const tempDir = await mkdtemp(join(tmpdir(), "acp-worker-workspace-smoke-"));
  const client = fakeClient([claimedRun(tempDir)]);
  const adapter: ExecutionAdapter = {
    execute: async (input) => ({
      status: "succeeded",
      summary: `Workspace smoke completed for ${input.repositorySlug}.`,
      nextState: "Code Review",
      events: [
        {
          eventType: "workspace.ready",
          message: "Workspace context was passed into the execution adapter.",
          payload: {
            workspacePath: input.workspacePath ?? null,
            workspaceStrategy: input.workspaceStrategy ?? null,
          },
        },
        {
          eventType: "codex.agent_message",
          message: "Worker workspace smoke executed.",
        },
      ],
    }),
  };

  try {
    const result = await runHttpOnce({
      config: workerConfig(tempDir),
      executionAdapter: adapter,
      controlPlaneClient: client,
    });

    if (result.completed.length !== 1 || result.failed.length !== 0) {
      throw new Error(`Unexpected worker result: ${JSON.stringify(result)}`);
    }

    if (client.calls.progress < 2 || client.calls.complete !== 1) {
      throw new Error(
        `Worker did not report progress and completion: ${JSON.stringify(client.calls)}`,
      );
    }

    console.log("worker_workspace_smoke=passed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function fakeClient(claimed: WorkerClaimedRunContract[]): WorkerApiClient & { calls: SmokeCalls } {
  const calls: SmokeCalls = {
    register: 0,
    claim: 0,
    heartbeat: 0,
    events: 0,
    progress: 0,
    artifacts: 0,
    complete: 0,
    fail: 0,
  };

  return {
    calls,
    register: async () => {
      calls.register += 1;
      return { ok: true };
    },
    claim: async () => {
      calls.claim += 1;
      return { claimed, skipped: [] };
    },
    heartbeat: async () => {
      calls.heartbeat += 1;
      return { ok: true };
    },
    events: async () => {
      calls.events += 1;
      return { ok: true };
    },
    progress: async () => {
      calls.progress += 1;
      return { ok: true };
    },
    artifacts: async () => {
      calls.artifacts += 1;
      return { ok: true };
    },
    complete: async () => {
      calls.complete += 1;
      return { ok: true };
    },
    fail: async () => {
      calls.fail += 1;
      return { ok: true };
    },
  };
}

function claimedRun(workspacePath: string): WorkerClaimedRunContract {
  return {
    run: {
      runId: "workspace-smoke-run",
      taskId: "workspace-smoke-task",
      identifier: "SMOKE-1",
      repositoryId: "workspace-smoke-repo",
      repositorySlug: "aiworkspace",
      repositoryGitUrl: "git@github.com:michaelx1993/aiworkspace.git",
      repositoryDefaultBranch: "main",
      repositoryLocalPath: workspacePath,
      role: "development",
      status: "claimed",
      leaseOwner: "worker-workspace-smoke",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      attempt: 1,
    },
    promptRelease: {
      id: "workspace-smoke-prompt",
      contentHash: "workspace-smoke-hash",
      renderedContent: "Use the provided workspace context and finish the smoke task.",
    },
  };
}

function workerConfig(workspaceRoot: string): WorkerConfig {
  return {
    runLoop: false,
    intervalMs: 60_000,
    leaseTtlMs: 900_000,
    leaseRenewalIntervalMs: 300_000,
    stalledAfterMs: 1_200_000,
    retryBackoffMs: 300_000,
    workerId: "worker-workspace-smoke",
    controlPlaneBaseUrl: "https://control-plane.invalid",
    workerApiToken: "worker-smoke-token",
    executionAdapter: "codex-cli",
    workspaceRoot,
    workspaceStrategy: "git-worktree",
    langfuse: {
      enabled: false,
      environment: "smoke",
    },
    monitoringAlerts: {
      minIntervalMs: 900_000,
      replayLimit: 10,
      retryBackoffMs: 300_000,
      format: "generic",
    },
  };
}

main().catch((error: unknown) => {
  console.error("worker_workspace_smoke=failed");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
