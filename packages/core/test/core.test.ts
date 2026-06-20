import { describe, expect, it } from "vitest";
import {
  canTransition,
  decideDispatch,
  parseRepositorySlugFromLabels,
  renderPrompt,
  roleForState,
  workerApiOpenApiDocument,
  workerApiPaths,
} from "../src/index.js";

describe("workflow state machine", () => {
  it("routes automatic states to role agents", () => {
    expect(roleForState("Todo")).toBe("intake");
    expect(roleForState("Development")).toBe("development");
    expect(roleForState("Code Review")).toBe("code_review");
    expect(roleForState("In Merge")).toBe("merge");
  });

  it("allows review feedback to return work to development", () => {
    expect(canTransition("Code Review", "Development")).toBe(true);
    expect(canTransition("Human Review", "Development")).toBe(true);
    expect(canTransition("Development", "Merged")).toBe(false);
  });
});

describe("repository routing", () => {
  it("parses repo fallback labels", () => {
    expect(parseRepositorySlugFromLabels(["Feature", "repo:crs-src"])).toBe("crs-src");
    expect(parseRepositorySlugFromLabels([{ name: "repo:traffic" }])).toBe("traffic");
  });
});

describe("dispatch decisions", () => {
  const repositories = [
    { id: "repo-1", slug: "crs-src", status: "active" as const },
    { id: "repo-2", slug: "traffic", status: "archived" as const },
  ];

  it("accepts automatic tasks with a resolvable active repository", () => {
    const decision = decideDispatch(
      {
        id: "task-1",
        identifier: "TOK-1",
        title: "Build task sync",
        state: "Development",
        labels: ["repo:crs-src"],
      },
      repositories,
      [],
    );

    expect(decision).toEqual({
      dispatchable: true,
      role: "development",
      reasons: [],
    });
  });

  it("rejects manual gates, missing repositories, and active leases", () => {
    const decision = decideDispatch(
      {
        id: "task-2",
        identifier: "TOK-2",
        title: "Human check",
        state: "Human Review",
      },
      repositories,
      [{ taskId: "task-2", status: "running", leaseExpiresAt: new Date("2099-01-01T00:00:00Z") }],
      new Date("2026-06-19T00:00:00Z"),
    );

    expect(decision.dispatchable).toBe(false);
    expect(decision.reasons).toEqual([
      "state Human Review is not automatic",
      "task has no resolvable repository",
      "task already has an active run lease",
    ]);
  });

  it("rejects tasks when repository or role concurrency is exhausted", () => {
    const now = new Date("2026-06-19T00:00:00Z");
    const activeRuns = [
      {
        taskId: "task-active",
        repositoryId: "repo-1",
        role: "development" as const,
        status: "running" as const,
        leaseExpiresAt: new Date("2099-01-01T00:00:00Z"),
      },
    ];

    const decision = decideDispatch(
      {
        id: "task-3",
        identifier: "TOK-3",
        title: "Build another feature",
        state: "Development",
        labels: ["repo:crs-src"],
      },
      repositories,
      activeRuns,
      now,
      {
        maxActiveRunsPerRepository: 1,
        maxActiveRunsPerRole: 1,
      },
    );

    expect(decision).toEqual({
      dispatchable: false,
      reasons: [
        "repository crs-src has reached active run concurrency limit",
        "role development has reached active run concurrency limit",
      ],
    });
  });

  it("rejects tasks that exceed the per-run estimated cost budget", () => {
    const decision = decideDispatch(
      {
        id: "task-4",
        identifier: "TOK-4",
        title: "Expensive run",
        state: "Development",
        labels: ["repo:crs-src"],
        estimatedCostUsd: 12.5,
      },
      repositories,
      [],
      new Date("2026-06-19T00:00:00Z"),
      {},
      {
        maxEstimatedCostUsdPerRun: 10,
      },
    );

    expect(decision).toEqual({
      dispatchable: false,
      reasons: ["task estimated cost exceeds per-run budget"],
    });
  });
});

describe("prompt rendering", () => {
  it("renders prompts in global to task context order", () => {
    const rendered = renderPrompt({
      components: [
        { id: "role", scope: "role", name: "Development", version: 1, content: "Implement." },
        { id: "team", scope: "team", name: "Token team", version: 2, content: "Think backend." },
        { id: "global", scope: "global", name: "Base", version: 1, content: "Use Chinese." },
      ],
      taskContext: "TOK-1: build API.",
      commentsAndWorkpad: "No blockers.",
      runtimeConstraints: "UTC-7 timestamps.",
    });

    expect(rendered.componentIds).toEqual(["global", "team", "role"]);
    expect(rendered.content).toContain("## global: Base v1");
    expect(rendered.content.indexOf("## global")).toBeLessThan(rendered.content.indexOf("## team"));
    expect(rendered.content.indexOf("## role")).toBeLessThan(
      rendered.content.indexOf("## task context"),
    );
  });
});

describe("Worker API contract", () => {
  it("keeps endpoint constants aligned with the OpenAPI document", () => {
    expect(workerApiPaths.claim).toBe("/api/worker/v1/runs/claim");
    expect(workerApiPaths.complete).toBe("/api/worker/v1/runs/{runId}/complete");
    expect(Object.keys(workerApiOpenApiDocument.paths)).toEqual([
      "/api/worker/v1/register",
      "/api/worker/v1/runs/claim",
      "/api/worker/v1/runs/{runId}/heartbeat",
      "/api/worker/v1/runs/{runId}/events",
      "/api/worker/v1/runs/{runId}/progress",
      "/api/worker/v1/runs/{runId}/artifacts",
      "/api/worker/v1/runs/{runId}/complete",
      "/api/worker/v1/runs/{runId}/fail",
    ]);
    expect(
      workerApiOpenApiDocument.paths["/api/worker/v1/runs/{runId}/progress"].post.parameters,
    ).toContainEqual({ $ref: "#/components/parameters/idempotencyKey" });
  });
});
