import { workerApiOpenApiDocument, workerApiPaths } from "@agent-control-plane/core";
import { describe, expect, it, vi } from "vitest";
import { HttpControlPlaneClient, WorkerApiError } from "../src/control-plane-client";

describe("HttpControlPlaneClient", () => {
  it("registers the worker with bearer auth and worker id headers", async () => {
    const requests: Array<{ url: string | URL; init?: RequestInit }> = [];
    const client = new HttpControlPlaneClient({
      baseUrl: "https://control-plane.example.com",
      workerId: "worker-1",
      workerApiToken: "token-1",
      fetch: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse({ ok: true, worker: { id: "worker-1" }, accepted: true });
      },
    });

    await expect(client.register()).resolves.toEqual({
      ok: true,
      worker: { id: "worker-1" },
      accepted: true,
    });

    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.url)).toBe(
      "https://control-plane.example.com/api/worker/v1/register",
    );
    expect(requests[0]?.init?.method).toBe("POST");
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer token-1");
    expect(headers.get("x-acp-worker-id")).toBe("worker-1");
  });

  it("claims runs through the Worker API contract path", async () => {
    const requests: Array<{ url: string | URL; init?: RequestInit }> = [];
    const client = new HttpControlPlaneClient({
      baseUrl: "https://control-plane.example.com/base/",
      workerId: "worker-1",
      fetch: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse({ ok: true, claimed: [], skipped: [], stalled: 0 });
      },
    });

    await expect(client.claim({ maxRuns: 2, executionAdapter: "codex-cli" })).resolves.toEqual({
      ok: true,
      claimed: [],
      skipped: [],
      stalled: 0,
    });

    expect(String(requests[0]?.url)).toBe(
      "https://control-plane.example.com/api/worker/v1/runs/claim",
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      maxRuns: 2,
      executionAdapter: "codex-cli",
    });
  });

  it("requires idempotency keys and sends them for run write commands", async () => {
    const requests: Array<{ url: string | URL; init?: RequestInit }> = [];
    const client = new HttpControlPlaneClient({
      baseUrl: "https://control-plane.example.com",
      workerId: "worker-1",
      fetch: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse({
          ok: true,
          run: {
            runId: "run-1",
            taskId: "task-1",
            status: "running",
          },
        });
      },
    });

    await expect(
      client.heartbeat("run/1", { leaseTtlMs: 60000 }, { idempotencyKey: "idem-1" }),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        runId: "run-1",
      },
    });

    expect(String(requests[0]?.url)).toBe(
      "https://control-plane.example.com/api/worker/v1/runs/run%2F1/heartbeat",
    );
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("idempotency-key")).toBe("idem-1");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ leaseTtlMs: 60000 });

    await expect(client.progress("run-1", { body: "x" }, { idempotencyKey: "" })).rejects.toThrow(
      "idempotencyKey is required",
    );
  });

  it("covers every OpenAPI run write endpoint with idempotent client methods", async () => {
    const requests: Array<{ url: string | URL; init?: RequestInit }> = [];
    const client = new HttpControlPlaneClient({
      baseUrl: "https://control-plane.example.com",
      workerId: "worker-1",
      workerApiToken: "token-1",
      fetch: async (url, init) => {
        requests.push({ url, init });
        if (String(url).endsWith("/events") || String(url).endsWith("/artifacts")) {
          return jsonResponse({ ok: true, events: [] });
        }
        if (String(url).endsWith("/progress")) {
          return jsonResponse({ ok: true, progress: { inserted: true } });
        }
        return jsonResponse({
          ok: true,
          run: {
            runId: "run-1",
            taskId: "task-1",
            status: "running",
          },
        });
      },
    });

    const writeOperations = [
      {
        method: () =>
          client.heartbeat("run 1", { leaseTtlMs: 60000 }, { idempotencyKey: "idem-heartbeat" }),
        path: workerApiPaths.heartbeat,
        body: { leaseTtlMs: 60000 },
        idempotencyKey: "idem-heartbeat",
      },
      {
        method: () =>
          client.events(
            "run 1",
            { events: [{ eventType: "codex.output", message: "started" }] },
            { idempotencyKey: "idem-events" },
          ),
        path: workerApiPaths.events,
        body: { events: [{ eventType: "codex.output", message: "started" }] },
        idempotencyKey: "idem-events",
      },
      {
        method: () =>
          client.progress(
            "run 1",
            { body: "Agent Status: Running" },
            { idempotencyKey: "idem-progress" },
          ),
        path: workerApiPaths.progress,
        body: { body: "Agent Status: Running" },
        idempotencyKey: "idem-progress",
      },
      {
        method: () =>
          client.artifacts(
            "run 1",
            { urls: ["https://github.com/michaelx1993/agent-worker/pull/1"] },
            { idempotencyKey: "idem-artifacts" },
          ),
        path: workerApiPaths.artifacts,
        body: { urls: ["https://github.com/michaelx1993/agent-worker/pull/1"] },
        idempotencyKey: "idem-artifacts",
      },
      {
        method: () =>
          client.complete(
            "run 1",
            { resultSummary: "done", nextStateSuggestion: "Code Review" },
            { idempotencyKey: "idem-complete" },
          ),
        path: workerApiPaths.complete,
        body: { resultSummary: "done", nextStateSuggestion: "Code Review" },
        idempotencyKey: "idem-complete",
      },
      {
        method: () =>
          client.fail(
            "run 1",
            { failureReason: "failed", retryable: false },
            { idempotencyKey: "idem-fail" },
          ),
        path: workerApiPaths.fail,
        body: { failureReason: "failed", retryable: false },
        idempotencyKey: "idem-fail",
      },
    ];

    const openApiWritePaths = Object.entries(workerApiOpenApiDocument.paths)
      .filter(([, operation]) =>
        operation.post.parameters.some(
          (parameter) =>
            "$ref" in parameter && parameter.$ref === "#/components/parameters/idempotencyKey",
        ),
      )
      .map(([path]) => path);

    expect(writeOperations.map((operation) => operation.path)).toEqual(openApiWritePaths);

    for (const operation of writeOperations) {
      await operation.method();
    }

    expect(requests).toHaveLength(writeOperations.length);
    writeOperations.forEach((operation, index) => {
      const request = requests[index];
      expect(String(request?.url)).toBe(
        `https://control-plane.example.com${operation.path.replace("{runId}", "run%201")}`,
      );
      const headers = new Headers(request?.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer token-1");
      expect(headers.get("x-acp-worker-id")).toBe("worker-1");
      expect(headers.get("idempotency-key")).toBe(operation.idempotencyKey);
      expect(JSON.parse(String(request?.init?.body))).toEqual(operation.body);
    });
  });

  it("throws structured WorkerApiError for non-2xx responses", async () => {
    const client = new HttpControlPlaneClient({
      baseUrl: "https://control-plane.example.com",
      workerId: "worker-1",
      fetch: vi.fn(async () =>
        jsonResponse(
          {
            ok: false,
            error: "Run lease is not active for this worker.",
            reason: "lease_not_active",
          },
          409,
        ),
      ),
    });

    await expect(
      client.complete("run-1", { resultSummary: "done" }, { idempotencyKey: "idem-1" }),
    ).rejects.toMatchObject({
      name: "WorkerApiError",
      status: 409,
      reason: "lease_not_active",
    });

    await client
      .complete("run-1", { resultSummary: "done" }, { idempotencyKey: "idem-2" })
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(WorkerApiError);
        expect((error as WorkerApiError).payload).toMatchObject({
          reason: "lease_not_active",
        });
      });
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
