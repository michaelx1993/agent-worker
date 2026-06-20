import { loadWorkerConfig } from "./config.js";
import { LangfuseTelemetry } from "./telemetry/langfuse.js";

async function main() {
  const config = loadWorkerConfig();
  if (!config.langfuse.enabled) {
    throw new Error(
      "LANGFUSE_ENABLED=true plus LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required",
    );
  }

  if (process.env.LANGFUSE_SMOKE_DRY_RUN === "true") {
    console.log("langfuse_smoke=passed");
    console.log("mode=dry-run");
    console.log(`base_url=${config.langfuse.baseUrl ?? ""}`);
    console.log(`project_id=${config.langfuse.projectId ?? ""}`);
    return;
  }

  const telemetry = new LangfuseTelemetry(config.langfuse);
  const observation = telemetry.startRun({
    runId: `langfuse-smoke-${Date.now()}`,
    taskId: "langfuse-smoke-task",
    identifier: "LANGFUSE-SMOKE",
    repositorySlug: "agent-control-plane",
    role: "Smoke",
    workerId: config.workerId,
    executionAdapter: "langfuse-smoke",
    model: "smoke",
    renderedPrompt: "Agent Control Plane Langfuse smoke.",
  });

  const trace = observation.complete({
    status: "succeeded",
    summary: "Agent Control Plane Langfuse smoke completed.",
    inputTokens: 8,
    outputTokens: 8,
    latencyMs: 1,
  });

  await telemetry.shutdown();

  if (!trace?.traceId) {
    throw new Error("Langfuse smoke did not produce a trace id");
  }

  console.log("langfuse_smoke=passed");
  console.log(`trace_id=${trace.traceId}`);
  if (trace.uiUrl) {
    console.log(`ui_url=${trace.uiUrl}`);
  }
}

main().catch((error: unknown) => {
  console.error("langfuse_smoke=failed");
  console.error(`error=${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
