import { describe, expect, it, vi } from "vitest";
import type { WorkerClaimedRunContract } from "@agent-control-plane/core";
import type { ExecutionAdapter, RunExecutionResult } from "../src/adapters/types";
import type { WorkerConfig } from "../src/config";
import { runHttpOnce, type WorkerApiClient } from "../src/http-runner";

describe("runHttpOnce", () => {
  it("claims runs over HTTP and reports successful execution", async () => {
    const client = fakeClient([claimedRun()]);
    const adapter = fakeAdapter({
      status: "succeeded",
      summary: "implemented",
      nextState: "Code Review",
      events: [
        {
          eventType: "codex.agent_message",
          message: "Implemented feature.",
        },
      ],
      conversation: {
        provider: "codex-cli",
        conversationId: "codex-run-1",
      },
      traces: [
        {
          provider: "mock",
          traceId: "trace-1",
        },
      ],
    });

    await expect(
      runHttpOnce({
        config: workerConfig(),
        executionAdapter: adapter,
        controlPlaneClient: client,
      }),
    ).resolves.toMatchObject({
      workerId: "worker-http-test",
      completed: [{ runId: "run-1", taskId: "task-1", status: "succeeded" }],
      failed: [],
    });

    expect(client.register).toHaveBeenCalledTimes(1);
    expect(client.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseTtlMs: 900000,
        retryBackoffMs: 300000,
        executionAdapter: "mock-openhands",
      }),
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        taskId: "task-1",
        repositoryGitUrl: "git@example.com:repo.git",
        renderedPrompt: "rendered prompt",
      }),
    );
    expect(client.complete).toHaveBeenCalledWith(
      "run-1",
      {
        resultSummary: "implemented",
        nextStateSuggestion: "Code Review",
      },
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("run-1:complete:"),
      }),
    );
    expect(client.progress).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        body: expect.stringContaining("Agent Status: Completed."),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("run-1:progress-completed:"),
      }),
    );
    expect(client.artifacts).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        conversation: expect.objectContaining({ conversationId: "codex-run-1" }),
        traces: [expect.objectContaining({ traceId: "trace-1" })],
      }),
      expect.any(Object),
    );
  });

  it("reports failed execution through Worker API fail and progress calls", async () => {
    const client = fakeClient([claimedRun()]);
    const adapter = fakeAdapter({
      status: "failed",
      reason: "tests failed",
      retryable: false,
      events: [
        {
          eventType: "codex.exec_command",
          message: "pnpm test failed.",
        },
      ],
    });

    await expect(
      runHttpOnce({
        config: workerConfig(),
        executionAdapter: adapter,
        controlPlaneClient: client,
      }),
    ).resolves.toMatchObject({
      completed: [],
      failed: [{ runId: "run-1", taskId: "task-1", status: "failed" }],
    });

    expect(client.fail).toHaveBeenCalledWith(
      "run-1",
      {
        failureReason: "tests failed",
        retryable: false,
      },
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("run-1:fail:"),
      }),
    );
    expect(client.progress).toHaveBeenCalledWith(
      "run-1",
      { body: "Agent Status: Failed. tests failed" },
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("run-1:progress-failed:"),
      }),
    );
  });

  it("turns adapter exceptions into retryable Worker API failures", async () => {
    const client = fakeClient([claimedRun()]);
    const adapter = {
      execute: vi.fn(async () => {
        throw new Error("adapter crashed");
      }),
    };

    await expect(
      runHttpOnce({
        config: workerConfig(),
        executionAdapter: adapter,
        controlPlaneClient: client,
      }),
    ).resolves.toMatchObject({
      completed: [],
      failed: [{ runId: "run-1", taskId: "task-1", status: "failed" }],
    });

    expect(client.events).toHaveBeenCalledWith(
      "run-1",
      {
        events: [
          expect.objectContaining({
            eventType: "worker.adapter_error",
            message: "Execution adapter threw before returning a terminal result.",
          }),
        ],
      },
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("run-1:adapter-error-event:"),
      }),
    );
    expect(client.fail).toHaveBeenCalledWith(
      "run-1",
      {
        failureReason: "adapter crashed",
        retryable: true,
      },
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("run-1:adapter-error-fail:"),
      }),
    );
  });

  it("redacts secrets before sending execution evidence to the Worker API", async () => {
    const client = fakeClient([claimedRun()]);
    const adapter = fakeAdapter({
      status: "succeeded",
      summary: "implemented with api_key=sk_abcdefghijklmnopqrstuvwxyz",
      nextState: "Code Review",
      events: [
        {
          eventType: "codex.exec_command",
          message:
            'OPENAI_API_KEY=sk-proj_1234567890abcdef curl -H "Authorization: Bearer token123456789" https://example.test',
          payload: {
            stderr: "password=hunter2 token=supersecrettoken",
          },
        },
      ],
      conversation: {
        provider: "codex-cli",
        conversationId: "codex-run-1",
        eventLogUri: "https://logs.example.test?token=supersecrettoken",
      },
      traces: [
        {
          provider: "mock",
          traceId: "trace-1",
          inputTokens: 1,
          outputTokens: 2,
          uiUrl: "https://trace.example.test?api_key=sk_abcdefghijklmnopqrstuvwxyz",
        },
      ],
    });

    await runHttpOnce({
      config: workerConfig(),
      executionAdapter: adapter,
      controlPlaneClient: client,
    });

    const outboundPayloads = JSON.stringify([
      vi.mocked(client.events).mock.calls,
      vi.mocked(client.progress).mock.calls,
      vi.mocked(client.artifacts).mock.calls,
      vi.mocked(client.complete).mock.calls,
    ]);

    expect(outboundPayloads).not.toContain("sk_abcdefghijklmnopqrstuvwxyz");
    expect(outboundPayloads).not.toContain("sk-proj_1234567890abcdef");
    expect(outboundPayloads).not.toContain("Bearer token123456789");
    expect(outboundPayloads).not.toContain("hunter2");
    expect(outboundPayloads).not.toContain("supersecrettoken");
    expect(outboundPayloads).toContain("[REDACTED]");
  });
});

function fakeClient(claimed: WorkerClaimedRunContract[]): WorkerApiClient {
  return {
    register: vi.fn(async () => ({ ok: true })),
    claim: vi.fn(async () => ({ claimed, skipped: [] })),
    heartbeat: vi.fn(async () => ({ ok: true })),
    events: vi.fn(async () => ({ ok: true })),
    progress: vi.fn(async () => ({ ok: true })),
    artifacts: vi.fn(async () => ({ ok: true })),
    complete: vi.fn(async () => ({ ok: true })),
    fail: vi.fn(async () => ({ ok: true })),
  };
}

function fakeAdapter(result: RunExecutionResult): ExecutionAdapter {
  return {
    execute: vi.fn(async () => result),
  };
}

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
      leaseOwner: "worker-http-test",
      leaseExpiresAt: "2026-06-20T10:00:00Z",
      attempt: 1,
    },
    promptRelease: {
      id: "prompt-release-1",
      contentHash: "hash",
      renderedContent: "rendered prompt",
    },
  };
}

function workerConfig(): WorkerConfig {
  return {
    runLoop: false,
    intervalMs: 60_000,
    leaseTtlMs: 900_000,
    leaseRenewalIntervalMs: 300_000,
    stalledAfterMs: 1_200_000,
    retryBackoffMs: 300_000,
    workerId: "worker-http-test",
    controlPlaneBaseUrl: "https://control-plane.example.com",
    workerApiToken: "worker-token",
    executionAdapter: "mock-openhands",
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
