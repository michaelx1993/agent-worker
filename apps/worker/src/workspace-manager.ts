import { execFile } from "node:child_process";
import { mkdir, access } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { WorkerClaimedRunContract } from "@agent-control-plane/core";
import type { WorkerConfig, WorkerWorkspaceStrategy } from "./config.js";
import { resolveClaimedRunRuntime } from "./runtime-snapshot.js";

export interface PreparedWorkerWorkspace {
  strategy: "local-path" | "git-worktree" | "ephemeral";
  path: string;
  baseRef: string;
  headRef: string;
}

export interface WorkerWorkspacePreparer {
  prepare(input: {
    config: WorkerConfig;
    claimed: WorkerClaimedRunContract;
  }): Promise<PreparedWorkerWorkspace>;
}

const execFileAsync = promisify(execFile);

export class LocalWorkerWorkspacePreparer implements WorkerWorkspacePreparer {
  async prepare(input: {
    config: WorkerConfig;
    claimed: WorkerClaimedRunContract;
  }): Promise<PreparedWorkerWorkspace> {
    return prepareWorkerWorkspace(input);
  }
}

export async function prepareWorkerWorkspace(input: {
  config: WorkerConfig;
  claimed: WorkerClaimedRunContract;
}): Promise<PreparedWorkerWorkspace> {
  const { config, claimed } = input;
  const { run } = claimed;
  const runtime = resolveClaimedRunRuntime(claimed);
  const strategy = resolveWorkspaceStrategy(config.workspaceStrategy, runtime.repositoryLocalPath);
  const baseRef = runtime.repositoryDefaultBranch;
  const headRef = `agent/${safePathSegment(run.runId).slice(0, 8)}`;

  if (strategy === "local-path") {
    const path = requireRepositoryLocalPath(runtime.repositoryLocalPath, strategy);
    return {
      strategy,
      path,
      baseRef,
      headRef,
    };
  }

  const path = workspacePath(config.workspaceRoot, runtime.repositorySlug, run.runId);

  if (strategy === "git-worktree") {
    const repositoryLocalPath = requireRepositoryLocalPath(runtime.repositoryLocalPath, strategy);
    await mkdir(parentDirectory(path), { recursive: true });
    await ensureGitWorktree({
      repositoryLocalPath,
      path,
      baseRef,
      headRef,
    });
    return {
      strategy,
      path,
      baseRef,
      headRef,
    };
  }

  await mkdir(path, { recursive: true });
  return {
    strategy: "ephemeral",
    path,
    baseRef,
    headRef,
  };
}

function resolveWorkspaceStrategy(
  requested: WorkerWorkspaceStrategy,
  repositoryLocalPath: string | undefined,
): PreparedWorkerWorkspace["strategy"] {
  if (requested === "local-path") {
    return "local-path";
  }

  if (requested === "git-worktree") {
    return "git-worktree";
  }

  if (requested === "ephemeral") {
    return "ephemeral";
  }

  return repositoryLocalPath ? "git-worktree" : "ephemeral";
}

function requireRepositoryLocalPath(
  repositoryLocalPath: string | undefined,
  strategy: string,
): string {
  if (!repositoryLocalPath) {
    throw new Error(`repositoryLocalPath is required for ${strategy} workspace strategy.`);
  }

  return repositoryLocalPath;
}

async function ensureGitWorktree(input: {
  repositoryLocalPath: string;
  path: string;
  baseRef: string;
  headRef: string;
}): Promise<void> {
  if (await pathExists(input.path)) {
    return;
  }

  await execFileAsync("git", [
    "-C",
    input.repositoryLocalPath,
    "worktree",
    "add",
    "-B",
    input.headRef,
    input.path,
    input.baseRef,
  ]);
}

function workspacePath(workspaceRoot: string, repositorySlug: string, runId: string): string {
  return `${normalizedWorkspaceRoot(workspaceRoot)}/${safePathSegment(repositorySlug)}/${safePathSegment(runId)}`;
}

function normalizedWorkspaceRoot(root: string): string {
  return root.replace(/\/+$/, "");
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function parentDirectory(path: string): string {
  const resolved = resolve(path);
  const index = resolved.lastIndexOf(sep);
  return index > 0 ? resolved.slice(0, index) : resolved;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
