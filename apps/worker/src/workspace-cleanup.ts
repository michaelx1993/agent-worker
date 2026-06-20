import { execFile } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { loadWorkerConfig } from "./config.js";

export interface WorkspaceCleanupCandidate {
  id: string;
  runId: string;
  strategy: "ephemeral" | "git-worktree";
  path: string;
  repositoryLocalPath?: string;
  finishedAt?: Date;
}

export interface WorkspaceCleanupOptions {
  workspaceRoot: string;
  retentionMs: number;
  limit: number;
  apply: boolean;
  now?: Date;
  candidates?: WorkspaceCleanupCandidate[];
  removePath?: (path: string) => Promise<void>;
  removeWorkspace?: (candidate: WorkspaceCleanupCandidate) => Promise<void>;
}

export interface WorkspaceCleanupSkipped {
  workspaceId: string;
  path: string;
  reason: string;
}

export interface WorkspaceCleanupSummary {
  apply: boolean;
  candidates: number;
  cleaned: number;
  skipped: WorkspaceCleanupSkipped[];
}

const execFileAsync = promisify(execFile);

export async function cleanupEphemeralWorkspaces(
  options: WorkspaceCleanupOptions,
): Promise<WorkspaceCleanupSummary> {
  const now = options.now ?? new Date();
  const olderThan = new Date(now.getTime() - options.retentionMs);
  const candidates = (options.candidates ?? (await listLocalWorkspaceCandidates(options)))
    .filter((candidate) => (candidate.finishedAt ?? olderThan).getTime() <= olderThan.getTime())
    .slice(0, options.limit);
  const removeWorkspace =
    options.removeWorkspace ??
    (async (candidate: WorkspaceCleanupCandidate) => {
      if (options.removePath) {
        await options.removePath(candidate.path);
        return;
      }

      await removeWorkspacePath(candidate);
    });
  const skipped: WorkspaceCleanupSkipped[] = [];
  let cleaned = 0;

  for (const candidate of candidates) {
    if (!isPathInsideRoot(candidate.path, options.workspaceRoot)) {
      skipped.push({
        workspaceId: candidate.id,
        path: candidate.path,
        reason: "outside_workspace_root",
      });
      continue;
    }

    if (options.apply) {
      await removeWorkspace(candidate);
      cleaned += 1;
    }
  }

  return {
    apply: options.apply,
    candidates: candidates.length,
    cleaned,
    skipped,
  };
}

export async function runWorkspaceCleanupCli(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkspaceCleanupSummary> {
  const config = loadWorkerConfig(env);
  const retentionMs = parsePositiveInt(env.WORKSPACE_CLEANUP_RETENTION_MS, 24 * 60 * 60_000);
  const limit = parsePositiveInt(env.WORKSPACE_CLEANUP_LIMIT, 50);

  return await cleanupEphemeralWorkspaces({
    workspaceRoot: config.workspaceRoot,
    retentionMs,
    limit,
    apply: env.WORKSPACE_CLEANUP_APPLY === "true",
  });
}

async function listLocalWorkspaceCandidates(
  options: WorkspaceCleanupOptions,
): Promise<WorkspaceCleanupCandidate[]> {
  const entries = await readdir(options.workspaceRoot, { recursive: true, withFileTypes: true });
  const candidates: WorkspaceCleanupCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = resolve(options.workspaceRoot, entry.parentPath, entry.name);
    const pathStat = await stat(path).catch(() => undefined);
    if (!pathStat) {
      continue;
    }
    candidates.push({
      id: path,
      runId: entry.name,
      strategy: "ephemeral",
      path,
      finishedAt: pathStat.mtime,
    });
  }

  return candidates;
}

function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function removeWorkspacePath(candidate: WorkspaceCleanupCandidate): Promise<void> {
  if (candidate.strategy === "git-worktree" && candidate.repositoryLocalPath) {
    try {
      await execFileAsync("git", [
        "-C",
        candidate.repositoryLocalPath,
        "worktree",
        "remove",
        "--force",
        candidate.path,
      ]);
      await execFileAsync("git", ["-C", candidate.repositoryLocalPath, "worktree", "prune"]);
      return;
    } catch {
      // Fall through to directory removal so stale workspaces do not block cleanup forever.
    }
  }

  await rm(candidate.path, { recursive: true, force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWorkspaceCleanupCli()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      if (!summary.apply) {
        console.log("Dry-run only. Set WORKSPACE_CLEANUP_APPLY=true to remove directories.");
      }
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
