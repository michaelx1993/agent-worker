import { setTimeout as sleep } from "node:timers/promises";
import { createExecutionAdapter } from "./adapters/index.js";
import type { ExecutionAdapter } from "./adapters/types.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import { runHttpOnce } from "./http-runner.js";

export async function runOnce(
  options: {
    config?: WorkerConfig;
    executionAdapter?: ExecutionAdapter;
  } = {},
) {
  const config = options.config ?? loadWorkerConfig();
  const ownsExecutionAdapter = !options.executionAdapter;
  const executionAdapter =
    options.executionAdapter ?? createExecutionAdapter(config.executionAdapter);

  try {
    if (config.controlPlaneBaseUrl) {
      return await runHttpOnce({
        config,
        executionAdapter,
      });
    }

    throw new Error("CONTROL_PLANE_BASE_URL is required for standalone agent-worker.");
  } finally {
    if (ownsExecutionAdapter) {
      await executionAdapter.dispose?.();
    }
  }
}

export async function runWorkerLoop(options: { signal?: AbortSignal } = {}) {
  const config = loadWorkerConfig();
  const executionAdapter = createExecutionAdapter(config.executionAdapter);
  const results = [];

  try {
    while (!options.signal?.aborted) {
      const result = await runOnce({ config, executionAdapter });
      results.push(result);
      console.log(JSON.stringify(result, null, 2));

      if (config.loopMaxIterations && results.length >= config.loopMaxIterations) {
        break;
      }

      if (options.signal?.aborted) {
        break;
      }

      try {
        await sleep(config.intervalMs, undefined, { signal: options.signal });
      } catch (error) {
        if (isAbortError(error)) {
          break;
        }
        throw error;
      }
    }
  } finally {
    await executionAdapter.dispose?.();
  }

  return {
    workerId: config.workerId,
    iterations: results.length,
    results,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadWorkerConfig();
  if (config.runLoop) {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    const result = await runWorkerLoop({ signal: controller.signal });
    console.log(JSON.stringify(result, null, 2));
  } else {
    const result = await runOnce();
    console.log(JSON.stringify(result, null, 2));
  }
}
