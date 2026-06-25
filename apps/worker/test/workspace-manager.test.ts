import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { WorkerClaimedRunContract } from "@agent-control-plane/core";
import type { WorkerConfig } from "../src/config";
import { prepareWorkerWorkspace } from "../src/workspace-manager";

const execFileAsync = promisify(execFile);

describe("prepareWorkerWorkspace", () => {
  it("creates a git worktree for a claimed run", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-worker-workspace-manager-"));
    const repoPath = join(root, "source");
    const workspaceRoot = join(root, "workspaces");

    try {
      await initRepository(repoPath);
      const workspace = await prepareWorkerWorkspace({
        config: workerConfig(workspaceRoot, "git-worktree"),
        claimed: claimedRun(repoPath),
      });

      expect(workspace).toMatchObject({
        strategy: "git-worktree",
        baseRef: "main",
        headRef: "agent/run-1",
      });
      expect(workspace.path).toContain(join("repo", "run-1"));
      await expect(access(join(workspace.path, ".git"))).resolves.toBeUndefined();

      const { stdout } = await execFileAsync("git", [
        "-C",
        repoPath,
        "worktree",
        "list",
        "--porcelain",
      ]);
      expect(stdout).toContain(workspace.path);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses local-path strategy without creating a separate workspace", async () => {
    const workspace = await prepareWorkerWorkspace({
      config: workerConfig("/tmp/acp-workspaces", "local-path"),
      claimed: claimedRun("/repos/repo"),
    });

    expect(workspace).toEqual({
      strategy: "local-path",
      path: "/repos/repo",
      baseRef: "main",
      headRef: "agent/run-1",
    });
  });

  it("uses repository workspace data from Plane runtime snapshot when present", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-worker-snapshot-workspace-"));
    const repoPath = join(root, "snapshot-source");
    const workspaceRoot = join(root, "workspaces");

    try {
      await initRepository(repoPath, "develop");
      const workspace = await prepareWorkerWorkspace({
        config: workerConfig(workspaceRoot, "git-worktree"),
        claimed: claimedRunWithRuntimeSnapshot(repoPath),
      });

      expect(workspace).toMatchObject({
        strategy: "git-worktree",
        baseRef: "develop",
        headRef: "agent/run-1",
      });
      expect(workspace.path).toContain(join("snapshot-repo", "run-1"));
      await expect(access(join(workspace.path, ".git"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to an ephemeral workspace when auto has no local repository path", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-worker-ephemeral-"));

    try {
      const workspace = await prepareWorkerWorkspace({
        config: workerConfig(root, "auto"),
        claimed: claimedRun(undefined),
      });

      expect(workspace.strategy).toBe("ephemeral");
      await expect(access(workspace.path)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function initRepository(path: string, branch = "main"): Promise<void> {
  await execFileAsync("git", ["init", "-b", branch, path]);
  await execFileAsync("git", ["-C", path, "config", "user.email", "agent@example.com"]);
  await execFileAsync("git", ["-C", path, "config", "user.name", "Agent"]);
  await execFileAsync("git", ["-C", path, "commit", "--allow-empty", "-m", "init"]);
}

function claimedRun(repositoryLocalPath: string | undefined): WorkerClaimedRunContract {
  return {
    run: {
      runId: "run-1",
      taskId: "task-1",
      identifier: "TOK-1",
      repositoryId: "repo-1",
      repositorySlug: "repo",
      repositoryGitUrl: "git@example.com:repo.git",
      repositoryDefaultBranch: "main",
      ...(repositoryLocalPath ? { repositoryLocalPath } : {}),
      role: "development",
      status: "claimed",
      leaseOwner: "worker-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      attempt: 1,
    },
    promptRelease: {
      id: "prompt-1",
      contentHash: "hash",
      renderedContent: "prompt",
    },
  };
}

function claimedRunWithRuntimeSnapshot(repositoryLocalPath: string): WorkerClaimedRunContract {
  return {
    ...claimedRun(undefined),
    planeRuntimeSnapshot: {
      id: "snapshot-1",
      snapshotHash: "snapshot-hash",
      payload: {
        schemaVersion: "plane-runtime-snapshot.v1",
        repository: {
          id: "repo-snapshot",
          slug: "snapshot-repo",
          gitUrl: "git@example.com:snapshot-repo.git",
          defaultBranch: "develop",
          localPath: repositoryLocalPath,
        },
        assembledPrompt: "snapshot prompt",
      },
    },
  };
}

function workerConfig(
  workspaceRoot: string,
  workspaceStrategy: WorkerConfig["workspaceStrategy"],
): WorkerConfig {
  return {
    runLoop: false,
    intervalMs: 60_000,
    leaseTtlMs: 900_000,
    leaseRenewalIntervalMs: 300_000,
    stalledAfterMs: 1_200_000,
    retryBackoffMs: 300_000,
    workerId: "worker-1",
    controlPlaneBaseUrl: "https://control-plane.example.com",
    workerApiToken: "token",
    executionAdapter: "codex-cli",
    workspaceRoot,
    workspaceStrategy,
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
