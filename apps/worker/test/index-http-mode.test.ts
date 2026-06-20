import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../src/config";

describe("runOnce HTTP mode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("claims over HTTP when CONTROL_PLANE_BASE_URL is configured", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ claimed: [], skipped: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const { runOnce } = await import("../src/index");
    const executionAdapter = {
      execute: vi.fn(),
      dispose: vi.fn(),
    };

    await expect(
      runOnce({
        config: workerConfig(),
        executionAdapter,
      }),
    ).resolves.toMatchObject({
      workerId: "worker-http-mode-test",
      claimed: [],
      completed: [],
      failed: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://control-plane.example.com/api/worker/v1/register",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://control-plane.example.com/api/worker/v1/runs/claim",
    );
    expect(executionAdapter.execute).not.toHaveBeenCalled();
    expect(executionAdapter.dispose).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function workerConfig(): WorkerConfig {
  return {
    runLoop: false,
    intervalMs: 60_000,
    leaseTtlMs: 900_000,
    leaseRenewalIntervalMs: 300_000,
    stalledAfterMs: 1_200_000,
    retryBackoffMs: 300_000,
    workerId: "worker-http-mode-test",
    controlPlaneBaseUrl: "https://control-plane.example.com",
    workerApiToken: "test-worker-token",
    executionAdapter: "codex-cli",
    workspaceRoot: "/tmp/workspaces",
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
