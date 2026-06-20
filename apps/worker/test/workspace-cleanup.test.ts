import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);

describe("cleanupEphemeralWorkspaces", () => {
  it("dry-runs cleanup candidates without deleting", async () => {
    const { cleanupEphemeralWorkspaces } = await import("../src/workspace-cleanup");
    const removeWorkspace = vi.fn();

    await expect(
      cleanupEphemeralWorkspaces({
        workspaceRoot: "/tmp/acp-workspaces",
        retentionMs: 86_400_000,
        limit: 25,
        apply: false,
        now: new Date("2026-06-19T12:00:00Z"),
        candidates: [workspaceCandidate()],
        removeWorkspace,
      }),
    ).resolves.toEqual({
      apply: false,
      candidates: 1,
      cleaned: 0,
      skipped: [],
    });

    expect(removeWorkspace).not.toHaveBeenCalled();
  });

  it("removes in-root candidates when apply is enabled", async () => {
    const candidate = workspaceCandidate();
    const { cleanupEphemeralWorkspaces } = await import("../src/workspace-cleanup");
    const removeWorkspace = vi.fn().mockResolvedValue(undefined);

    await expect(
      cleanupEphemeralWorkspaces({
        workspaceRoot: "/tmp/acp-workspaces",
        retentionMs: 86_400_000,
        limit: 25,
        apply: true,
        now: new Date("2026-06-19T12:00:00Z"),
        candidates: [candidate],
        removeWorkspace,
      }),
    ).resolves.toMatchObject({
      apply: true,
      candidates: 1,
      cleaned: 1,
      skipped: [],
    });

    expect(removeWorkspace).toHaveBeenCalledWith(candidate);
  });

  it("uses git worktree remove and prune for git-worktree candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-cleanup-"));
    const repoPath = join(root, "source");
    const workspaceRoot = join(root, "workspaces");
    const worktreePath = join(workspaceRoot, "crs-src", "run-1");

    try {
      await execFileAsync("git", ["init", "-b", "main", repoPath]);
      await execFileAsync("git", ["-C", repoPath, "config", "user.email", "agent@example.com"]);
      await execFileAsync("git", ["-C", repoPath, "config", "user.name", "Agent"]);
      await execFileAsync("git", ["-C", repoPath, "commit", "--allow-empty", "-m", "init"]);
      await execFileAsync("git", [
        "-C",
        repoPath,
        "worktree",
        "add",
        "-B",
        "agent/run-1",
        worktreePath,
        "main",
      ]);
      const { cleanupEphemeralWorkspaces } = await import("../src/workspace-cleanup");

      await expect(
        cleanupEphemeralWorkspaces({
          workspaceRoot,
          retentionMs: 86_400_000,
          limit: 25,
          apply: true,
          candidates: [
            {
              ...workspaceCandidate(),
              repositoryLocalPath: repoPath,
              path: worktreePath,
            },
          ],
        }),
      ).resolves.toMatchObject({
        apply: true,
        candidates: 1,
        cleaned: 1,
        skipped: [],
      });

      await expect(access(worktreePath)).rejects.toThrow();
      const { stdout } = await execFileAsync("git", [
        "-C",
        repoPath,
        "worktree",
        "list",
        "--porcelain",
      ]);
      expect(stdout).not.toContain(worktreePath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips candidates outside the configured workspace root", async () => {
    const { cleanupEphemeralWorkspaces } = await import("../src/workspace-cleanup");
    const removeWorkspace = vi.fn();

    await expect(
      cleanupEphemeralWorkspaces({
        workspaceRoot: "/tmp/acp-workspaces",
        retentionMs: 86_400_000,
        limit: 25,
        apply: true,
        candidates: [
          {
            ...workspaceCandidate(),
            path: "/Users/a/crs-src",
          },
        ],
        removeWorkspace,
      }),
    ).resolves.toEqual({
      apply: true,
      candidates: 1,
      cleaned: 0,
      skipped: [
        {
          workspaceId: "workspace-1",
          path: "/Users/a/crs-src",
          reason: "outside_workspace_root",
        },
      ],
    });

    expect(removeWorkspace).not.toHaveBeenCalled();
  });

  it("can discover local workspace directories from the workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-cleanup-scan-"));
    const workspace = join(root, "repo", "run-1");
    try {
      await mkdir(workspace, { recursive: true });
      const { cleanupEphemeralWorkspaces } = await import("../src/workspace-cleanup");

      await expect(
        cleanupEphemeralWorkspaces({
          workspaceRoot: root,
          retentionMs: 0,
          limit: 10,
          apply: false,
        }),
      ).resolves.toMatchObject({
        candidates: expect.any(Number),
        cleaned: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function workspaceCandidate() {
  return {
    id: "workspace-1",
    runId: "run-1",
    repositoryLocalPath: "/repos/crs-src",
    strategy: "git-worktree" as const,
    path: "/tmp/acp-workspaces/crs-src/run-1",
    finishedAt: new Date("2026-06-18T11:00:00Z"),
  };
}
