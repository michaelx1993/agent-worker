import { mkdtemp, mkdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupEphemeralWorkspaces } from "./workspace-cleanup.js";

async function main() {
  const root = await mkdtemp(join(tmpdir(), "acp-workspace-cleanup-smoke-"));
  const staleWorkspace = join(root, "aiworkspace", "run-stale");
  const outsideWorkspace = join(tmpdir(), "acp-workspace-cleanup-outside");

  try {
    await mkdir(staleWorkspace, { recursive: true });
    await mkdir(outsideWorkspace, { recursive: true });

    const dryRun = await cleanupEphemeralWorkspaces({
      workspaceRoot: root,
      retentionMs: 1,
      limit: 10,
      apply: false,
      now: new Date("2026-06-20T12:00:00Z"),
      candidates: [
        {
          id: "stale",
          runId: "run-stale",
          strategy: "ephemeral",
          path: staleWorkspace,
          finishedAt: new Date("2026-06-19T12:00:00Z"),
        },
      ],
    });

    if (dryRun.cleaned !== 0 || dryRun.candidates !== 1) {
      throw new Error(`Unexpected dry-run summary: ${JSON.stringify(dryRun)}`);
    }

    const applied = await cleanupEphemeralWorkspaces({
      workspaceRoot: root,
      retentionMs: 1,
      limit: 10,
      apply: true,
      now: new Date("2026-06-20T12:00:00Z"),
      candidates: [
        {
          id: "stale",
          runId: "run-stale",
          strategy: "ephemeral",
          path: staleWorkspace,
          finishedAt: new Date("2026-06-19T12:00:00Z"),
        },
        {
          id: "outside",
          runId: "run-outside",
          strategy: "ephemeral",
          path: outsideWorkspace,
          finishedAt: new Date("2026-06-19T12:00:00Z"),
        },
      ],
    });

    if (applied.cleaned !== 1 || applied.skipped[0]?.reason !== "outside_workspace_root") {
      throw new Error(`Unexpected apply summary: ${JSON.stringify(applied)}`);
    }

    await expectMissing(staleWorkspace);
    console.log("workspace_cleanup_smoke=passed");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideWorkspace, { recursive: true, force: true });
  }
}

async function expectMissing(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }

  throw new Error(`Expected workspace to be removed: ${path}`);
}

main().catch((error: unknown) => {
  console.error("workspace_cleanup_smoke=failed");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
