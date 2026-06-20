import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../src/config";

const config = vi.hoisted(() => ({
  loadWorkerConfig: vi.fn(),
}));

const adapters = vi.hoisted(() => ({
  createExecutionAdapter: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("../src/config", () => config);
vi.mock("../src/adapters/index.js", () => adapters);

describe("runWorkerLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    config.loadWorkerConfig.mockReturnValue(workerConfig());
    adapters.createExecutionAdapter.mockReturnValue({
      execute: vi.fn(),
      dispose: adapters.dispose,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reuses one execution adapter instance across HTTP loop iterations", async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).includes("/runs/claim")
        ? jsonResponse({ claimed: [], skipped: [] })
        : jsonResponse({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { runWorkerLoop } = await import("../src/index");
    const controller = new AbortController();
    const loop = runWorkerLoop({ signal: controller.signal });

    await waitForClaims(fetchMock, 2);
    controller.abort();

    const result = await loop;

    expect(result.iterations).toBeGreaterThan(1);
    expect(adapters.createExecutionAdapter).toHaveBeenCalledTimes(1);
    expect(adapters.createExecutionAdapter).toHaveBeenCalledWith("codex-app-server");
    expect(adapters.dispose).toHaveBeenCalledTimes(1);
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
    runLoop: true,
    intervalMs: 1,
    leaseTtlMs: 900_000,
    leaseRenewalIntervalMs: 300_000,
    stalledAfterMs: 1_200_000,
    retryBackoffMs: 300_000,
    workerId: "worker-loop-test",
    controlPlaneBaseUrl: "https://control-plane.example.com",
    executionAdapter: "codex-app-server",
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

async function waitForClaims(
  fetchMock: ReturnType<typeof vi.fn>,
  minClaims: number,
): Promise<void> {
  const startedAt = Date.now();
  while (countClaimCalls(fetchMock) < minClaims) {
    if (Date.now() - startedAt > 500) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function countClaimCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/runs/claim")).length;
}
