import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../src/config";

describe("loadWorkerConfig", () => {
  it("defaults to the Codex CLI execution adapter", () => {
    expect(loadWorkerConfig({})).toMatchObject({
      executionAdapter: "codex-cli",
      workspaceStrategy: "auto",
      monitoringAlerts: {
        minIntervalMs: 900000,
        replayLimit: 10,
        retryBackoffMs: 300000,
        format: "generic",
      },
    });
  });

  it("loads lease and stalled timing controls", () => {
    expect(
      loadWorkerConfig({
        WORKER_LEASE_TTL_MS: "120000",
        WORKER_LEASE_RENEWAL_INTERVAL_MS: "30000",
        WORKER_REPOSITORY_CONCURRENCY_LIMIT: "2",
        WORKER_ROLE_CONCURRENCY_LIMIT: "5",
        WORKER_AGENT_CONCURRENCY_LIMIT: "3",
        WORKER_MAX_ESTIMATED_COST_USD_PER_RUN: "1.25",
        WORKER_STALLED_AFTER_MS: "300000",
        WORKER_RETRY_BACKOFF_MS: "45000",
        WORKER_ID: "worker-test",
        CONTROL_PLANE_BASE_URL: "https://control-plane.example.com",
        ACP_WORKER_API_TOKEN: "worker-token",
        WORKER_EXECUTION_ADAPTER: "mock-openhands",
        WORKER_WORKSPACE_ROOT: "/tmp/acp-test-workspaces",
        WORKER_WORKSPACE_STRATEGY: "git-worktree",
        LANGFUSE_ENABLED: "true",
        LANGFUSE_PUBLIC_KEY: "pk-test",
        LANGFUSE_SECRET_KEY: "sk-test",
        LANGFUSE_BASE_URL: "https://cloud.langfuse.com",
        LANGFUSE_PROJECT_ID: "project-1",
        LANGFUSE_TRACING_ENVIRONMENT: "dev",
        LANGFUSE_RELEASE: "test-release",
        MONITORING_ALERT_WEBHOOK_URL: "https://hooks.example.com/acp",
        MONITORING_ALERT_MIN_INTERVAL_MS: "120000",
        MONITORING_ALERT_FORMAT: "slack",
        MONITORING_ALERT_REPLAY_LIMIT: "7",
        MONITORING_ALERT_RETRY_BACKOFF_MS: "180000",
      }),
    ).toMatchObject({
      leaseTtlMs: 120000,
      leaseRenewalIntervalMs: 30000,
      repositoryConcurrencyLimit: 2,
      roleConcurrencyLimit: 5,
      agentConcurrencyLimit: 3,
      maxEstimatedCostUsdPerRun: 1.25,
      stalledAfterMs: 300000,
      retryBackoffMs: 45000,
      workerId: "worker-test",
      controlPlaneBaseUrl: "https://control-plane.example.com",
      workerApiToken: "worker-token",
      executionAdapter: "mock-openhands",
      workspaceRoot: "/tmp/acp-test-workspaces",
      workspaceStrategy: "git-worktree",
      langfuse: {
        enabled: true,
        publicKey: "pk-test",
        secretKey: "sk-test",
        baseUrl: "https://cloud.langfuse.com",
        projectId: "project-1",
        environment: "dev",
        release: "test-release",
      },
      monitoringAlerts: {
        webhookUrl: "https://hooks.example.com/acp",
        minIntervalMs: 120000,
        replayLimit: 7,
        retryBackoffMs: 180000,
        format: "slack",
      },
    });
  });

  it("keeps Langfuse disabled until explicitly enabled with credentials", () => {
    expect(loadWorkerConfig({ LANGFUSE_ENABLED: "true" }).langfuse).toEqual({
      enabled: false,
      environment: "dev",
    });
    expect(
      loadWorkerConfig({
        LANGFUSE_PUBLIC_KEY: "pk-test",
        LANGFUSE_SECRET_KEY: "sk-test",
      }).langfuse,
    ).toEqual({
      enabled: false,
      publicKey: "pk-test",
      secretKey: "sk-test",
      environment: "dev",
    });
  });

  it("defaults lease renewal to one third of the lease ttl", () => {
    expect(loadWorkerConfig({ WORKER_LEASE_TTL_MS: "90000" })).toMatchObject({
      leaseTtlMs: 90000,
      leaseRenewalIntervalMs: 30000,
    });
  });

  it("supports email monitoring alert format", () => {
    expect(
      loadWorkerConfig({
        MONITORING_ALERT_WEBHOOK_URL: "https://hooks.example.com/email",
        MONITORING_ALERT_FORMAT: "email",
      }).monitoringAlerts,
    ).toEqual({
      webhookUrl: "https://hooks.example.com/email",
      minIntervalMs: 900000,
      replayLimit: 10,
      retryBackoffMs: 300000,
      format: "email",
    });
  });
});
