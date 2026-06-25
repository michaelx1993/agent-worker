import { execFile } from "node:child_process";
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorkerClaimedRunContract } from "@agent-control-plane/core";
import type { RunExecutionResult } from "./adapters/types.js";
import type { WorkerConfig } from "./config.js";
import type { PreparedWorkerWorkspace } from "./workspace-manager.js";
import { resolveClaimedRunRuntime } from "./runtime-snapshot.js";

export interface ProjectMetaGitArtifact {
  planeProjectWorkspaceId: string;
  localPath: string;
  commitSha?: string;
  filesChanged: string[];
  operation: "run_summary";
  summary: string;
}

export interface WriteProjectMetaGitInput {
  config: WorkerConfig;
  claimed: WorkerClaimedRunContract;
  workspace: PreparedWorkerWorkspace;
  execution: RunExecutionResult;
  summary: string;
}

const execFileAsync = promisify(execFile);

export async function writeProjectMetaGitForRun(
  input: WriteProjectMetaGitInput,
): Promise<ProjectMetaGitArtifact | undefined> {
  const runtime = resolveClaimedRunRuntime(input.claimed);
  const planeProjectWorkspaceId = runtime.project?.planeProjectWorkspaceId;
  if (!planeProjectWorkspaceId) {
    return undefined;
  }

  const localPath = projectMetaRepoPath(
    input.config.workspaceRoot,
    runtime.project?.slug ?? runtime.project?.id ?? planeProjectWorkspaceId,
  );
  await ensureGitRepo(localPath);

  const now = new Date().toISOString();
  const filesChanged = [
    "status.md",
    "progress.md",
    `runs/${input.claimed.run.runId}.md`,
    "artifacts/index.md",
  ];

  await mkdir(join(localPath, "runs"), { recursive: true });
  await mkdir(join(localPath, "artifacts"), { recursive: true });
  await writeFile(join(localPath, "status.md"), statusMarkdown(input, now), "utf8");
  await appendFile(join(localPath, "progress.md"), progressMarkdown(input, now), "utf8");
  await writeFile(
    join(localPath, "runs", `${input.claimed.run.runId}.md`),
    runMarkdown(input, now),
    "utf8",
  );
  await appendFile(join(localPath, "artifacts", "index.md"), artifactIndexMarkdown(input, now), {
    encoding: "utf8",
  });

  await execGit(localPath, ["add", ...filesChanged]);
  const commitSha = await commitProjectMetaRepo(localPath, input.claimed.run.runId);

  return {
    planeProjectWorkspaceId,
    localPath,
    ...(commitSha ? { commitSha } : {}),
    filesChanged,
    operation: "run_summary",
    summary: input.summary,
  };
}

function projectMetaRepoPath(workspaceRoot: string, projectKey: string): string {
  return join(workspaceRoot.replace(/\/+$/, ""), "_project-meta", safePathSegment(projectKey));
}

async function ensureGitRepo(localPath: string): Promise<void> {
  await mkdir(localPath, { recursive: true });
  if (!(await pathExists(join(localPath, ".git")))) {
    await execGit(localPath, ["init"]);
  }
  await execGit(localPath, ["config", "user.name", "Agent Worker"]);
  await execGit(localPath, ["config", "user.email", "agent-worker@localhost"]);
}

async function commitProjectMetaRepo(
  localPath: string,
  runId: string,
): Promise<string | undefined> {
  try {
    await execGit(localPath, ["commit", "-m", `Record agent run ${runId}`]);
  } catch (error) {
    const output = String((error as { stdout?: unknown; stderr?: unknown }).stdout ?? "")
      .concat(String((error as { stderr?: unknown }).stderr ?? ""))
      .toLowerCase();
    if (!output.includes("nothing to commit")) {
      throw error;
    }
  }

  return (await execGit(localPath, ["rev-parse", "HEAD"])).trim() || undefined;
}

function statusMarkdown(input: WriteProjectMetaGitInput, now: string): string {
  const runtime = resolveClaimedRunRuntime(input.claimed);
  const status = input.execution.status;
  return [
    "# Project Status",
    "",
    `Updated: ${now}`,
    `Project: ${runtime.project?.name ?? runtime.project?.slug ?? "unknown"}`,
    `Repository: ${runtime.repositorySlug}`,
    `Task: ${input.claimed.run.identifier}`,
    `Run: ${input.claimed.run.runId}`,
    `Role: ${input.claimed.run.role}`,
    `Status: ${status}`,
    input.execution.status === "succeeded" && input.execution.nextState
      ? `Next state: ${input.execution.nextState}`
      : undefined,
    `Workspace: ${input.workspace.path}`,
    "",
    "## Latest Summary",
    "",
    input.summary,
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function progressMarkdown(input: WriteProjectMetaGitInput, now: string): string {
  return [
    "",
    `## ${now} - ${input.claimed.run.identifier}`,
    "",
    `- Run: ${input.claimed.run.runId}`,
    `- Role: ${input.claimed.run.role}`,
    `- Status: ${input.execution.status}`,
    input.execution.status === "succeeded" && input.execution.nextState
      ? `- Next state: ${input.execution.nextState}`
      : undefined,
    `- Workspace: ${input.workspace.path}`,
    `- Summary: ${input.summary}`,
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function runMarkdown(input: WriteProjectMetaGitInput, now: string): string {
  const runtime = resolveClaimedRunRuntime(input.claimed);
  return [
    `# Run ${input.claimed.run.runId}`,
    "",
    `Created: ${now}`,
    `Task: ${input.claimed.run.identifier}`,
    `Repository: ${runtime.repositorySlug}`,
    `Role: ${input.claimed.run.role}`,
    `Status: ${input.execution.status}`,
    `Workspace strategy: ${input.workspace.strategy}`,
    `Workspace path: ${input.workspace.path}`,
    `Base ref: ${input.workspace.baseRef}`,
    `Head ref: ${input.workspace.headRef}`,
    "",
    "## Summary",
    "",
    input.summary,
    "",
  ].join("\n");
}

function artifactIndexMarkdown(input: WriteProjectMetaGitInput, now: string): string {
  return [
    "",
    `## ${now} - ${input.claimed.run.identifier}`,
    "",
    `- Run summary: runs/${input.claimed.run.runId}.md`,
    `- Workspace: ${input.workspace.path}`,
    `- Status: ${input.execution.status}`,
    "",
  ].join("\n");
}

async function execGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
  return result.stdout;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}
