import { createHash } from "node:crypto";
import type { AgentRole, WorkerClaimedRunContract } from "@agent-control-plane/core";
import type { ExecutionAdapter, RunExecutionEvent } from "./adapters/types.js";
import { HttpControlPlaneClient } from "./control-plane-client.js";
import type { WorkerConfig } from "./config.js";
import { summarizeExecutionEventsForProgress } from "./event-progress.js";
import { redactExecutionEvents, redactSensitivePayload, redactSensitiveText } from "./redaction.js";

export interface WorkerApiClient {
  register(): Promise<unknown>;
  claim(payload?: Record<string, unknown>): Promise<{
    claimed: WorkerClaimedRunContract[];
    skipped?: Array<{ identifier: string; reasons: string[] }>;
    stalled?: number;
  }>;
  heartbeat(
    runId: string,
    payload: { leaseTtlMs?: number; leaseExpiresAt?: string },
    options: { idempotencyKey: string },
  ): Promise<unknown>;
  events(
    runId: string,
    payload: { events: RunExecutionEvent[] },
    options: { idempotencyKey: string },
  ): Promise<unknown>;
  progress(
    runId: string,
    payload: { body: string; externalUrl?: string },
    options: { idempotencyKey: string },
  ): Promise<unknown>;
  artifacts(
    runId: string,
    payload: Record<string, unknown>,
    options: { idempotencyKey: string },
  ): Promise<unknown>;
  complete(
    runId: string,
    payload: { resultSummary: string; nextStateSuggestion?: string },
    options: { idempotencyKey: string },
  ): Promise<unknown>;
  fail(
    runId: string,
    payload: { failureReason: string; retryable?: boolean },
    options: { idempotencyKey: string },
  ): Promise<unknown>;
}

export interface HttpWorkerRunResult {
  workerId: string;
  claimed: HttpClaimedRunSummary[];
  completed: HttpRunLifecycleSummary[];
  failed: HttpRunLifecycleSummary[];
  stalled: HttpRunLifecycleSummary[];
  planeWritebackFailures: string[];
  monitoringAlertNotification: { status: "disabled" };
  skipped: Array<{ identifier: string; reasons: string[] }>;
  budgetBlocked: {
    blocked: number;
    taskIds: string[];
  };
}

export interface HttpClaimedRunSummary {
  runId: string;
  taskId: string;
  identifier: string;
  repositoryId: string;
  repositorySlug: string;
  repositoryGitUrl: string;
  repositoryDefaultBranch: string;
  repositoryLocalPath?: string;
  role: AgentRole;
  status: "claimed";
  leaseOwner: string;
  leaseExpiresAt: Date;
  attempt: number;
}

export interface HttpRunLifecycleSummary {
  runId: string;
  taskId: string;
  status: "succeeded" | "failed" | "stalled";
}

const agentRoles = new Set<AgentRole>([
  "intake",
  "development",
  "code_review",
  "merge",
  "release",
  "deploy",
  "human_gate",
  "terminal",
]);

export async function runHttpOnce(input: {
  config: WorkerConfig;
  executionAdapter: ExecutionAdapter;
  controlPlaneClient?: WorkerApiClient;
}): Promise<HttpWorkerRunResult> {
  const { config, executionAdapter } = input;
  const client =
    input.controlPlaneClient ??
    new HttpControlPlaneClient({
      baseUrl: requireControlPlaneBaseUrl(config),
      workerId: config.workerId,
      ...(config.workerApiToken ? { workerApiToken: config.workerApiToken } : {}),
    });

  await client.register();
  const claim = await client.claim({
    leaseTtlMs: config.leaseTtlMs,
    retryBackoffMs: config.retryBackoffMs,
    executionAdapter: config.executionAdapter,
    ...(config.repositoryConcurrencyLimit
      ? { repositoryConcurrencyLimit: config.repositoryConcurrencyLimit }
      : {}),
    ...(config.roleConcurrencyLimit ? { roleConcurrencyLimit: config.roleConcurrencyLimit } : {}),
    ...(config.agentConcurrencyLimit
      ? { agentConcurrencyLimit: config.agentConcurrencyLimit }
      : {}),
    ...(config.maxEstimatedCostUsdPerRun !== undefined
      ? { maxEstimatedCostUsdPerRun: config.maxEstimatedCostUsdPerRun }
      : {}),
  });
  const completed: HttpRunLifecycleSummary[] = [];
  const failed: HttpRunLifecycleSummary[] = [];

  for (const claimed of claim.claimed) {
    const result = await executeHttpClaimedRun({
      client,
      config,
      executionAdapter,
      claimed,
    });
    if (result === "completed") {
      completed.push({
        runId: claimed.run.runId,
        taskId: claimed.run.taskId,
        status: "succeeded",
      });
    } else {
      failed.push({
        runId: claimed.run.runId,
        taskId: claimed.run.taskId,
        status: "failed",
      });
    }
  }

  return {
    workerId: config.workerId,
    claimed: claim.claimed.map(toClaimedRunSummary),
    completed,
    failed,
    stalled: [],
    planeWritebackFailures: [],
    monitoringAlertNotification: { status: "disabled" },
    skipped: claim.skipped ?? [],
    budgetBlocked: {
      blocked: 0,
      taskIds: [],
    },
  };
}

function toClaimedRunSummary(claimed: WorkerClaimedRunContract): HttpClaimedRunSummary {
  const { run } = claimed;
  return {
    runId: run.runId,
    taskId: run.taskId,
    identifier: run.identifier,
    repositoryId: run.repositoryId,
    repositorySlug: run.repositorySlug,
    repositoryGitUrl: run.repositoryGitUrl,
    repositoryDefaultBranch: run.repositoryDefaultBranch,
    ...(run.repositoryLocalPath ? { repositoryLocalPath: run.repositoryLocalPath } : {}),
    role: parseAgentRole(run.role),
    status: "claimed",
    leaseOwner: run.leaseOwner,
    leaseExpiresAt: new Date(run.leaseExpiresAt),
    attempt: run.attempt,
  };
}

async function executeHttpClaimedRun(input: {
  client: WorkerApiClient;
  config: WorkerConfig;
  executionAdapter: ExecutionAdapter;
  claimed: WorkerClaimedRunContract;
}): Promise<"completed" | "failed"> {
  const { client, config, executionAdapter, claimed } = input;
  const { run } = claimed;

  await client.heartbeat(
    run.runId,
    { leaseExpiresAt: nextLeaseExpiryIso(config) },
    writeOptions(run.runId, "heartbeat", { leaseTtlMs: config.leaseTtlMs }),
  );
  await client.progress(
    run.runId,
    {
      body: `Agent Status: Running. ${run.role} agent claimed ${run.identifier} on ${run.repositorySlug}.`,
    },
    writeOptions(run.runId, "progress-running", { identifier: run.identifier }),
  );

  try {
    const execution = await executionAdapter.execute({
      runId: run.runId,
      taskId: run.taskId,
      identifier: run.identifier,
      repositoryId: run.repositoryId,
      repositorySlug: run.repositorySlug,
      repositoryGitUrl: run.repositoryGitUrl,
      role: parseAgentRole(run.role),
      leaseOwner: run.leaseOwner,
      promptReleaseId: claimed.promptRelease.id,
      renderedPrompt: claimed.promptRelease.renderedContent,
      ...(claimed.previousConversation
        ? { previousConversation: claimed.previousConversation }
        : {}),
    });

    const events = redactExecutionEvents(execution.events);

    if (events.length) {
      await client.events(run.runId, { events }, writeOptions(run.runId, "events", events));
      const eventProgress = summarizeExecutionEventsForProgress(events);
      if (eventProgress) {
        await client.progress(
          run.runId,
          { body: eventProgress },
          writeOptions(run.runId, "progress-events", { eventProgress }),
        );
      }
    }

    if (execution.conversation || execution.traces?.length) {
      const artifacts = redactSensitivePayload({
        conversation: execution.conversation,
        traces: execution.traces ?? [],
      });
      await client.artifacts(run.runId, artifacts, writeOptions(run.runId, "artifacts", artifacts));
    }

    if (execution.status === "succeeded") {
      const summary = redactSensitiveText(execution.summary);
      await client.complete(
        run.runId,
        {
          resultSummary: summary,
          ...(execution.nextState ? { nextStateSuggestion: execution.nextState } : {}),
        },
        writeOptions(run.runId, "complete", {
          summary,
          nextState: execution.nextState,
        }),
      );
      await client.progress(
        run.runId,
        {
          body: `Agent Status: Completed. ${summary}${
            execution.nextState ? ` Next state: ${execution.nextState}.` : ""
          }`,
        },
        writeOptions(run.runId, "progress-completed", {
          summary,
          nextState: execution.nextState,
        }),
      );
      return "completed";
    }

    const failureReason = redactSensitiveText(execution.reason);
    await client.fail(
      run.runId,
      {
        failureReason,
        retryable: execution.retryable,
      },
      writeOptions(run.runId, "fail", {
        reason: failureReason,
        retryable: execution.retryable,
      }),
    );
    await client.progress(
      run.runId,
      { body: `Agent Status: Failed. ${failureReason}` },
      writeOptions(run.runId, "progress-failed", { reason: failureReason }),
    );
    return "failed";
  } catch (error) {
    const reason = redactSensitiveText(error instanceof Error ? error.message : String(error));
    await client.progress(
      run.runId,
      { body: `Agent Status: Failed. Adapter error before terminal result: ${reason}` },
      writeOptions(run.runId, "progress-adapter-error", { reason }),
    );
    await client.events(
      run.runId,
      {
        events: [
          {
            eventType: "worker.adapter_error",
            message: "Execution adapter threw before returning a terminal result.",
            payload: {
              adapter: config.executionAdapter,
              retryable: true,
              reason,
            },
          },
        ],
      },
      writeOptions(run.runId, "adapter-error-event", { reason }),
    );
    await client.fail(
      run.runId,
      {
        failureReason: reason,
        retryable: true,
      },
      writeOptions(run.runId, "adapter-error-fail", { reason }),
    );
    return "failed";
  }
}

function writeOptions(
  runId: string,
  operation: string,
  payload: unknown,
): { idempotencyKey: string } {
  return {
    idempotencyKey: `${runId}:${operation}:${sha256(stableStringify(payload))}`,
  };
}

function requireControlPlaneBaseUrl(config: WorkerConfig): string {
  if (!config.controlPlaneBaseUrl) {
    throw new Error("CONTROL_PLANE_BASE_URL is required for HTTP worker mode.");
  }

  return config.controlPlaneBaseUrl;
}

function nextLeaseExpiryIso(config: WorkerConfig): string {
  return new Date(Date.now() + config.leaseTtlMs).toISOString();
}

function parseAgentRole(role: string): AgentRole {
  if (agentRoles.has(role as AgentRole)) {
    return role as AgentRole;
  }

  throw new Error(`Unsupported agent role from Worker API claim: ${role}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
