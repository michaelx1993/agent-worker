export const workerApiVersion = "v1";

export const workerApiPaths = {
  register: "/api/worker/v1/register",
  claim: "/api/worker/v1/runs/claim",
  heartbeat: "/api/worker/v1/runs/{runId}/heartbeat",
  events: "/api/worker/v1/runs/{runId}/events",
  progress: "/api/worker/v1/runs/{runId}/progress",
  artifacts: "/api/worker/v1/runs/{runId}/artifacts",
  complete: "/api/worker/v1/runs/{runId}/complete",
  fail: "/api/worker/v1/runs/{runId}/fail",
  openapi: "/api/worker/v1/openapi.json",
} as const;

export type WorkerApiPath = (typeof workerApiPaths)[keyof typeof workerApiPaths];

export interface WorkerApiErrorResponse {
  ok: false;
  error: string;
  reason: string;
}

export interface WorkerRegisterResponse {
  ok: true;
  worker: {
    id: string;
  };
  accepted: true;
}

export interface WorkerRunClaimRequest {
  leaseTtlMs?: number;
  maxRuns?: number;
  retryBackoffMs?: number;
  stalledAfterMs?: number;
  repositoryConcurrencyLimit?: number;
  roleConcurrencyLimit?: number;
  agentConcurrencyLimit?: number;
  maxEstimatedCostUsdPerRun?: number;
  executionAdapter?: string;
}

export interface WorkerPromptReleaseContract {
  id: string;
  contentHash: string;
  renderedContent: string;
}

export interface WorkerPreviousConversationContract {
  provider: string;
  conversationId: string;
  eventLogUri?: string;
  uiUrl?: string;
}

export interface WorkerPlaneRuntimeSnapshotContract {
  id: string;
  snapshotHash: string;
  payload: unknown;
}

export interface WorkerClaimedRunContract {
  run: {
    runId: string;
    taskId: string;
    identifier: string;
    repositoryId: string;
    repositorySlug: string;
    repositoryGitUrl: string;
    repositoryDefaultBranch: string;
    repositoryLocalPath?: string;
    role: string;
    status: "claimed";
    leaseOwner: string;
    leaseExpiresAt: string;
    attempt: number;
  };
  promptRelease: WorkerPromptReleaseContract;
  planeRuntimeSnapshot?: WorkerPlaneRuntimeSnapshotContract;
  previousConversation?: WorkerPreviousConversationContract;
}

export interface WorkerRunClaimResponse {
  ok: true;
  claimed: WorkerClaimedRunContract[];
  skipped: Array<{
    taskId: string;
    identifier: string;
    reasons: string[];
  }>;
  stalled: number;
}

export interface WorkerRunHeartbeatRequest {
  leaseTtlMs?: number;
  leaseExpiresAt?: string;
}

export interface WorkerRunLifecycleContract {
  runId: string;
  taskId: string;
  status: "running" | "succeeded" | "failed" | "stalled";
  heartbeatAt?: string;
  finishedAt?: string;
  nextState?: string;
}

export interface WorkerRunLifecycleResponse {
  ok: true;
  run: WorkerRunLifecycleContract;
}

export interface WorkerRunEventInput {
  eventType: string;
  message: string;
  payload?: unknown;
}

export interface WorkerRunEventsRequest {
  events: WorkerRunEventInput[];
}

export interface WorkerRunEventContract {
  id: string;
  eventType: string;
  message: string;
  payload: unknown;
  createdAt: string;
}

export interface WorkerRunEventsResponse {
  ok: true;
  events: WorkerRunEventContract[];
}

export interface WorkerRunProgressRequest {
  body: string;
  externalUrl?: string;
}

export interface WorkerRunProgressResponse {
  ok: true;
  progress: {
    inserted: boolean;
    taskId?: string;
    progressId?: string;
    reason?: string;
  };
}

export interface WorkerRunArtifactsRequest {
  files?: string[];
  urls?: string[];
  metadata?: Record<string, unknown>;
  projectMetaGit?: {
    planeProjectWorkspaceId: string;
    localPath: string;
    remoteUrl?: string;
    commitSha?: string;
    filesChanged: string[];
    operation?: string;
    summary?: string;
  };
  conversation?: {
    provider: string;
    conversationId: string;
    eventLogUri?: string;
    eventCursor?: string;
    uiUrl?: string;
  };
  traces?: Array<Record<string, unknown>>;
}

export interface WorkerRunCompleteRequest {
  resultSummary: string;
  nextStateSuggestion?: string;
}

export interface WorkerRunFailRequest {
  failureReason: string;
  retryable?: boolean;
}

export const workerApiOpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Agent Control Plane Worker API",
    version: workerApiVersion,
  },
  servers: [{ url: "http://127.0.0.1:3112" }],
  security: [{ workerBearer: [], workerHeader: [] }],
  components: {
    securitySchemes: {
      workerBearer: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "ACP_WORKER_API_TOKEN",
      },
      workerHeader: {
        type: "apiKey",
        in: "header",
        name: "x-acp-worker-token",
      },
    },
    parameters: {
      workerId: {
        name: "x-acp-worker-id",
        in: "header",
        required: true,
        schema: { type: "string", minLength: 1 },
      },
      runId: {
        name: "runId",
        in: "path",
        required: true,
        schema: { type: "string", minLength: 1 },
      },
      idempotencyKey: {
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", minLength: 1 },
      },
    },
    schemas: {
      Error: objectSchema({
        ok: { const: false },
        error: { type: "string" },
        reason: { type: "string" },
      }),
      RegisterResponse: objectSchema({
        ok: { const: true },
        worker: objectSchema({ id: { type: "string" } }),
        accepted: { const: true },
      }),
      ClaimRequest: objectSchema(
        {
          leaseTtlMs: positiveIntegerSchema(),
          maxRuns: positiveIntegerSchema(),
          retryBackoffMs: positiveIntegerSchema(),
          stalledAfterMs: positiveIntegerSchema(),
          repositoryConcurrencyLimit: positiveIntegerSchema(),
          roleConcurrencyLimit: positiveIntegerSchema(),
          agentConcurrencyLimit: positiveIntegerSchema(),
          maxEstimatedCostUsdPerRun: { type: "number", minimum: 0 },
          executionAdapter: { type: "string" },
        },
        [],
      ),
      ClaimResponse: objectSchema({
        ok: { const: true },
        claimed: {
          type: "array",
          items: objectSchema({
            run: { type: "object", additionalProperties: true },
            promptRelease: objectSchema({
              id: { type: "string" },
              contentHash: { type: "string" },
              renderedContent: { type: "string" },
            }),
            planeRuntimeSnapshot: objectSchema({
              id: { type: "string" },
              snapshotHash: { type: "string" },
              payload: { type: "object", additionalProperties: true },
            }),
            previousConversation: { type: "object", additionalProperties: true },
          }),
        },
        skipped: {
          type: "array",
          items: objectSchema({
            taskId: { type: "string" },
            identifier: { type: "string" },
            reasons: { type: "array", items: { type: "string" } },
          }),
        },
        stalled: { type: "integer", minimum: 0 },
      }),
      HeartbeatRequest: objectSchema(
        {
          leaseTtlMs: positiveIntegerSchema(),
          leaseExpiresAt: { type: "string", format: "date-time" },
        },
        [],
      ),
      LifecycleResponse: objectSchema({
        ok: { const: true },
        run: { type: "object", additionalProperties: true },
      }),
      EventsRequest: objectSchema({
        events: {
          type: "array",
          minItems: 1,
          items: objectSchema({
            eventType: { type: "string", minLength: 1 },
            message: { type: "string", minLength: 1 },
            payload: true,
          }),
        },
      }),
      EventsResponse: objectSchema({
        ok: { const: true },
        events: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      }),
      ProgressRequest: objectSchema({
        body: { type: "string", minLength: 1 },
        externalUrl: { type: "string" },
      }),
      ProgressResponse: objectSchema({
        ok: { const: true },
        progress: { type: "object", additionalProperties: true },
      }),
      ArtifactsRequest: objectSchema(
        {
          files: { type: "array", items: { type: "string" } },
          urls: { type: "array", items: { type: "string" } },
          metadata: { type: "object", additionalProperties: true },
          projectMetaGit: objectSchema(
            {
              planeProjectWorkspaceId: { type: "string", minLength: 1 },
              localPath: { type: "string", minLength: 1 },
              remoteUrl: { type: "string" },
              commitSha: { type: "string" },
              filesChanged: { type: "array", minItems: 1, items: { type: "string" } },
              operation: { type: "string" },
              summary: { type: "string" },
            },
            ["planeProjectWorkspaceId", "localPath", "filesChanged"],
          ),
          conversation: objectSchema({
            provider: { type: "string", minLength: 1 },
            conversationId: { type: "string", minLength: 1 },
            eventLogUri: { type: "string" },
            eventCursor: { type: "string" },
            uiUrl: { type: "string" },
          }),
          traces: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        [],
      ),
      CompleteRequest: objectSchema({
        resultSummary: { type: "string", minLength: 1 },
        nextStateSuggestion: { type: "string" },
      }),
      FailRequest: objectSchema({
        failureReason: { type: "string", minLength: 1 },
        retryable: { type: "boolean" },
      }),
    },
  },
  paths: {
    [workerApiPaths.register]: postOperation("Register worker", undefined, "RegisterResponse"),
    [workerApiPaths.claim]: postOperation("Claim runs", "ClaimRequest", "ClaimResponse"),
    [workerApiPaths.heartbeat]: runPostOperation(
      "Heartbeat run",
      "HeartbeatRequest",
      "LifecycleResponse",
    ),
    [workerApiPaths.events]: runPostOperation(
      "Append run events",
      "EventsRequest",
      "EventsResponse",
    ),
    [workerApiPaths.progress]: runPostOperation(
      "Record run progress",
      "ProgressRequest",
      "ProgressResponse",
    ),
    [workerApiPaths.artifacts]: runPostOperation(
      "Record run artifacts",
      "ArtifactsRequest",
      "EventsResponse",
    ),
    [workerApiPaths.complete]: runPostOperation(
      "Complete run",
      "CompleteRequest",
      "LifecycleResponse",
    ),
    [workerApiPaths.fail]: runPostOperation("Fail run", "FailRequest", "LifecycleResponse"),
  },
} as const;

function postOperation(summary: string, requestSchema: string | undefined, responseSchema: string) {
  return {
    post: {
      summary,
      parameters: [{ $ref: "#/components/parameters/workerId" }],
      ...(requestSchema ? { requestBody: jsonRequestBody(requestSchema) } : {}),
      responses: standardResponses(responseSchema),
    },
  };
}

function runPostOperation(summary: string, requestSchema: string, responseSchema: string) {
  const operation = postOperation(summary, requestSchema, responseSchema);
  return {
    post: {
      ...operation.post,
      parameters: [
        { $ref: "#/components/parameters/workerId" },
        { $ref: "#/components/parameters/runId" },
        { $ref: "#/components/parameters/idempotencyKey" },
      ],
    },
  };
}

function jsonRequestBody(schema: string) {
  return {
    required: true,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schema}` },
      },
    },
  };
}

function standardResponses(successSchema: string) {
  return {
    "200": jsonResponse(successSchema),
    "400": jsonResponse("Error"),
    "401": jsonResponse("Error"),
    "409": jsonResponse("Error"),
  };
}

function jsonResponse(schema: string) {
  return {
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schema}` },
      },
    },
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required = Object.keys(properties),
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function positiveIntegerSchema() {
  return { type: "integer", minimum: 1 };
}
