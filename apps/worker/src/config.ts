export interface WorkerConfig {
  runLoop: boolean;
  loopMaxIterations?: number;
  intervalMs: number;
  leaseTtlMs: number;
  leaseRenewalIntervalMs: number;
  repositoryConcurrencyLimit?: number;
  roleConcurrencyLimit?: number;
  agentConcurrencyLimit?: number;
  maxEstimatedCostUsdPerRun?: number;
  stalledAfterMs: number;
  retryBackoffMs: number;
  workerId: string;
  controlPlaneBaseUrl?: string;
  workerApiToken?: string;
  executionAdapter: string;
  workspaceRoot: string;
  workspaceStrategy: WorkerWorkspaceStrategy;
  langfuse: WorkerLangfuseConfig;
  monitoringAlerts: WorkerMonitoringAlertConfig;
}

export interface WorkerLangfuseConfig {
  enabled: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  projectId?: string;
  environment: string;
  release?: string;
}

export interface WorkerMonitoringAlertConfig {
  webhookUrl?: string;
  minIntervalMs: number;
  replayLimit: number;
  retryBackoffMs: number;
  format: WorkerMonitoringAlertFormat;
}

export type WorkerMonitoringAlertFormat = "generic" | "slack" | "email";
export type WorkerWorkspaceStrategy = "auto" | "local-path" | "git-worktree" | "ephemeral";

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const publicKey = normalizeOptional(env.LANGFUSE_PUBLIC_KEY);
  const secretKey = normalizeOptional(env.LANGFUSE_SECRET_KEY);
  const baseUrl = normalizeOptional(env.LANGFUSE_BASE_URL);
  const projectId = normalizeOptional(env.LANGFUSE_PROJECT_ID);
  const release = normalizeOptional(env.LANGFUSE_RELEASE);
  const monitoringAlertWebhookUrl = normalizeOptional(env.MONITORING_ALERT_WEBHOOK_URL);
  const leaseTtlMs = parsePositiveInt(env.WORKER_LEASE_TTL_MS, 15 * 60_000);
  const monitoringAlertMinIntervalMs = parsePositiveInt(
    env.MONITORING_ALERT_MIN_INTERVAL_MS,
    15 * 60_000,
  );
  const monitoringAlertReplayLimit = parsePositiveInt(env.MONITORING_ALERT_REPLAY_LIMIT, 10);
  const monitoringAlertRetryBackoffMs = parsePositiveInt(
    env.MONITORING_ALERT_RETRY_BACKOFF_MS,
    5 * 60_000,
  );
  const monitoringAlertFormat = parseMonitoringAlertFormat(env.MONITORING_ALERT_FORMAT);
  const monitoringAlerts: WorkerMonitoringAlertConfig = monitoringAlertWebhookUrl
    ? {
        webhookUrl: monitoringAlertWebhookUrl,
        minIntervalMs: monitoringAlertMinIntervalMs,
        replayLimit: monitoringAlertReplayLimit,
        retryBackoffMs: monitoringAlertRetryBackoffMs,
        format: monitoringAlertFormat,
      }
    : {
        minIntervalMs: monitoringAlertMinIntervalMs,
        replayLimit: monitoringAlertReplayLimit,
        retryBackoffMs: monitoringAlertRetryBackoffMs,
        format: monitoringAlertFormat,
      };

  return {
    runLoop: env.WORKER_RUN_LOOP === "true",
    ...optionalPositiveInt("loopMaxIterations", env.WORKER_LOOP_MAX_ITERATIONS),
    intervalMs: parsePositiveInt(env.WORKER_LOOP_INTERVAL_MS, 60_000),
    leaseTtlMs,
    leaseRenewalIntervalMs: parsePositiveInt(
      env.WORKER_LEASE_RENEWAL_INTERVAL_MS,
      Math.max(1_000, Math.floor(leaseTtlMs / 3)),
    ),
    ...optionalPositiveInt("repositoryConcurrencyLimit", env.WORKER_REPOSITORY_CONCURRENCY_LIMIT),
    ...optionalPositiveInt("roleConcurrencyLimit", env.WORKER_ROLE_CONCURRENCY_LIMIT),
    ...optionalPositiveInt("agentConcurrencyLimit", env.WORKER_AGENT_CONCURRENCY_LIMIT),
    ...optionalNonNegativeNumber(
      "maxEstimatedCostUsdPerRun",
      env.WORKER_MAX_ESTIMATED_COST_USD_PER_RUN,
    ),
    stalledAfterMs: parsePositiveInt(env.WORKER_STALLED_AFTER_MS, 20 * 60_000),
    retryBackoffMs: parseNonNegativeInt(env.WORKER_RETRY_BACKOFF_MS, 5 * 60_000),
    workerId: env.WORKER_ID?.trim() || `worker-${process.pid}`,
    ...optionalString("controlPlaneBaseUrl", env.CONTROL_PLANE_BASE_URL),
    ...optionalString("workerApiToken", env.ACP_WORKER_API_TOKEN),
    executionAdapter: env.WORKER_EXECUTION_ADAPTER?.trim() || "codex-cli",
    workspaceRoot:
      normalizeOptional(env.WORKER_WORKSPACE_ROOT) ?? "/tmp/agent-control-plane-workspaces",
    workspaceStrategy: parseWorkspaceStrategy(env.WORKER_WORKSPACE_STRATEGY),
    langfuse: {
      enabled: env.LANGFUSE_ENABLED === "true" && Boolean(publicKey && secretKey),
      ...(publicKey ? { publicKey } : {}),
      ...(secretKey ? { secretKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(projectId ? { projectId } : {}),
      environment: normalizeOptional(env.LANGFUSE_TRACING_ENVIRONMENT) ?? "dev",
      ...(release ? { release } : {}),
    },
    monitoringAlerts,
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function optionalPositiveInt<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, number>> {
  if (!value) {
    return {};
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? ({ [key]: parsed } as Record<K, number>) : {};
}

function optionalNonNegativeNumber<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, number>> {
  if (!value) {
    return {};
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? ({ [key]: parsed } as Record<K, number>) : {};
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function optionalString<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  const normalized = normalizeOptional(value);
  return normalized ? ({ [key]: normalized } as Record<K, string>) : {};
}

function parseMonitoringAlertFormat(value: string | undefined): WorkerMonitoringAlertFormat {
  const normalized = normalizeOptional(value)?.toLowerCase();
  if (normalized === "slack" || normalized === "email") {
    return normalized;
  }

  return "generic";
}

function parseWorkspaceStrategy(value: string | undefined): WorkerWorkspaceStrategy {
  const normalized = normalizeOptional(value)?.toLowerCase();
  if (normalized === "local-path" || normalized === "git-worktree" || normalized === "ephemeral") {
    return normalized;
  }

  return "auto";
}
