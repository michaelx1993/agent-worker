import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkerClaimedRunContract } from "@agent-control-plane/core";
import type { WorkerConfig } from "../src/config";
import { writeProjectMetaGitForRun } from "../src/project-meta-git";

describe("writeProjectMetaGitForRun", () => {
  it("writes project memory files and commits them to a local git repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-worker-meta-"));
    try {
      const artifact = await writeProjectMetaGitForRun({
        config: workerConfig(root),
        claimed: claimedRun(),
        workspace: {
          strategy: "git-worktree",
          path: "/tmp/workspaces/repo/run-1",
          baseRef: "main",
          headRef: "agent/run-1",
        },
        execution: {
          status: "succeeded",
          summary: "implemented feature",
          nextState: "Code Review",
          events: [],
        },
        summary: "implemented feature",
      });

      expect(artifact).toMatchObject({
        planeProjectWorkspaceId: "plane-project-workspace-1",
        commitSha: expect.any(String),
        filesChanged: ["status.md", "progress.md", "runs/run-1.md", "artifacts/index.md"],
      });
      expect(artifact?.localPath).toContain("_project-meta/project-token");

      const status = await readFile(join(artifact?.localPath ?? "", "status.md"), "utf8");
      const progress = await readFile(join(artifact?.localPath ?? "", "progress.md"), "utf8");
      const run = await readFile(join(artifact?.localPath ?? "", "runs", "run-1.md"), "utf8");
      const index = await readFile(
        join(artifact?.localPath ?? "", "artifacts", "index.md"),
        "utf8",
      );

      expect(status).toContain("Project: Token Project");
      expect(status).toContain("Status: succeeded");
      expect(progress).toContain("Summary: implemented feature");
      expect(run).toContain("# Run run-1");
      expect(index).toContain("Run summary: runs/run-1.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to ACP project identity when Plane project workspace projection is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-worker-meta-"));
    try {
      const claimed = claimedRun();
      claimed.planeRuntimeSnapshot = {
        id: "snapshot-1",
        snapshotHash: "snapshot-hash",
        payload: {
          schemaVersion: "plane-runtime-snapshot.v1",
          project: {
            id: "project-local-1",
            slug: "token",
            name: "Token Project",
          },
        },
      };

      const artifact = await writeProjectMetaGitForRun({
        config: workerConfig(root),
        claimed,
        workspace: {
          strategy: "git-worktree",
          path: "/tmp/workspaces/repo/run-1",
          baseRef: "main",
          headRef: "agent/run-1",
        },
        execution: {
          status: "succeeded",
          summary: "implemented feature without projection",
          nextState: "Code Review",
          events: [],
        },
        summary: "implemented feature without projection",
      });

      expect(artifact).toMatchObject({
        planeProjectWorkspaceId: "project-local-1",
        commitSha: expect.any(String),
        filesChanged: ["status.md", "progress.md", "runs/run-1.md", "artifacts/index.md"],
      });
      expect(artifact?.localPath).toContain("_project-meta/token");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function claimedRun(): WorkerClaimedRunContract {
  return {
    run: {
      runId: "run-1",
      taskId: "task-1",
      identifier: "TOK-1",
      repositoryId: "repo-1",
      repositorySlug: "repo",
      repositoryGitUrl: "git@example.com:repo.git",
      repositoryDefaultBranch: "main",
      role: "development",
      status: "claimed",
      leaseOwner: "worker-test",
      leaseExpiresAt: "2026-06-20T10:00:00Z",
      attempt: 1,
    },
    promptRelease: {
      id: "prompt-release-1",
      contentHash: "hash",
      renderedContent: "rendered prompt",
    },
    planeRuntimeSnapshot: {
      id: "snapshot-1",
      snapshotHash: "snapshot-hash",
      payload: {
        schemaVersion: "plane-runtime-snapshot.v1",
        project: {
          id: "project-1",
          slug: "project-token",
          name: "Token Project",
          planeProjectWorkspaceId: "plane-project-workspace-1",
        },
      },
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
    workerId: "worker-test",
    controlPlaneBaseUrl: "https://control-plane.example.com",
    workerApiToken: "worker-token",
    executionAdapter: "codex-cli",
    workspaceRoot,
    workspaceStrategy: "git-worktree",
    langfuse: {
      enabled: false,
      environment: "test",
    },
    monitoringAlerts: {
      minIntervalMs: 900_000,
      replayLimit: 10,
      retryBackoffMs: 300_000,
      format: "generic",
    },
  };
}
