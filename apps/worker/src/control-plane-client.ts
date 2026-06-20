import {
  workerApiPaths,
  type WorkerRegisterResponse,
  type WorkerRunArtifactsRequest,
  type WorkerRunClaimRequest,
  type WorkerRunClaimResponse,
  type WorkerRunCompleteRequest,
  type WorkerRunEventsRequest,
  type WorkerRunEventsResponse,
  type WorkerRunFailRequest,
  type WorkerRunHeartbeatRequest,
  type WorkerRunLifecycleResponse,
  type WorkerRunProgressRequest,
  type WorkerRunProgressResponse,
} from "@agent-control-plane/core";

export interface HttpControlPlaneClientOptions {
  baseUrl: string;
  workerId: string;
  workerApiToken?: string;
  fetch?: typeof fetch;
}

export interface WorkerWriteRequestOptions {
  idempotencyKey: string;
}

export class WorkerApiError extends Error {
  readonly status: number;
  readonly reason?: string;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "WorkerApiError";
    this.status = status;
    this.payload = payload;
    if (payload && typeof payload === "object" && "reason" in payload) {
      const reason = (payload as { reason?: unknown }).reason;
      if (typeof reason === "string") {
        this.reason = reason;
      }
    }
  }
}

export class HttpControlPlaneClient {
  private readonly baseUrl: URL;
  private readonly workerId: string;
  private readonly workerApiToken: string | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(options: HttpControlPlaneClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.workerId = options.workerId;
    this.workerApiToken = options.workerApiToken;
    this.fetchFn = options.fetch ?? fetch;
  }

  register(): Promise<WorkerRegisterResponse> {
    return this.post(workerApiPaths.register, {});
  }

  claim(payload: WorkerRunClaimRequest = {}): Promise<WorkerRunClaimResponse> {
    return this.post(workerApiPaths.claim, payload);
  }

  heartbeat(
    runId: string,
    payload: WorkerRunHeartbeatRequest,
    options: WorkerWriteRequestOptions,
  ): Promise<WorkerRunLifecycleResponse> {
    return this.postRun(workerApiPaths.heartbeat, runId, payload, options);
  }

  events(
    runId: string,
    payload: WorkerRunEventsRequest,
    options: WorkerWriteRequestOptions,
  ): Promise<WorkerRunEventsResponse> {
    return this.postRun(workerApiPaths.events, runId, payload, options);
  }

  progress(
    runId: string,
    payload: WorkerRunProgressRequest,
    options: WorkerWriteRequestOptions,
  ): Promise<WorkerRunProgressResponse> {
    return this.postRun(workerApiPaths.progress, runId, payload, options);
  }

  artifacts(
    runId: string,
    payload: WorkerRunArtifactsRequest,
    options: WorkerWriteRequestOptions,
  ): Promise<WorkerRunEventsResponse> {
    return this.postRun(workerApiPaths.artifacts, runId, payload, options);
  }

  complete(
    runId: string,
    payload: WorkerRunCompleteRequest,
    options: WorkerWriteRequestOptions,
  ): Promise<WorkerRunLifecycleResponse> {
    return this.postRun(workerApiPaths.complete, runId, payload, options);
  }

  fail(
    runId: string,
    payload: WorkerRunFailRequest,
    options: WorkerWriteRequestOptions,
  ): Promise<WorkerRunLifecycleResponse> {
    return this.postRun(workerApiPaths.fail, runId, payload, options);
  }

  private async postRun<T>(
    pathTemplate: string,
    runId: string,
    payload: unknown,
    options: WorkerWriteRequestOptions,
  ): Promise<T> {
    if (!options.idempotencyKey.trim()) {
      throw new Error("idempotencyKey is required for Worker API write requests.");
    }

    return this.post<T>(pathTemplate.replace("{runId}", encodeURIComponent(runId)), payload, {
      "idempotency-key": options.idempotencyKey,
    });
  }

  private async post<T>(
    path: string,
    payload: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const response = await this.fetchFn(this.url(path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-acp-worker-id": this.workerId,
        ...(this.workerApiToken ? { authorization: `Bearer ${this.workerApiToken}` } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
    });
    const body = await parseResponseBody(response);
    if (!response.ok) {
      throw new WorkerApiError(workerApiErrorMessage(body, response.status), response.status, body);
    }

    return body as T;
  }

  private url(path: string): string {
    const url = new URL(path, this.baseUrl);
    return url.toString();
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return response.text();
  }

  return response.json().catch(() => undefined);
}

function workerApiErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) {
      return error;
    }
  }

  return `Worker API request failed with status ${status}.`;
}
