import { createCodexAppServerAdapter } from "./codex-app-server.js";
import { createCodexCliAdapter } from "./codex-cli.js";
import { createMockOpenHandsAdapter } from "./mock-openhands.js";
import { createOpenHandsCloudAdapter } from "./openhands-cloud.js";
import type { ExecutionAdapter } from "./types.js";

export type ExecutionAdapterMode =
  | "mock-openhands"
  | "openhands-cloud"
  | "codex-cli"
  | "codex-app-server";

export function createExecutionAdapter(mode: string = "codex-cli"): ExecutionAdapter {
  if (mode === "codex-app-server") {
    return createCodexAppServerAdapter();
  }
  if (mode === "codex-cli") {
    return createCodexCliAdapter();
  }

  if (mode === "mock-openhands") {
    return createMockOpenHandsAdapter();
  }

  if (mode === "openhands-cloud") {
    return createOpenHandsCloudAdapter();
  }

  throw new Error(`Unsupported worker execution adapter: ${mode}`);
}

export type { ExecutionAdapter, RunExecutionInput, RunExecutionResult } from "./types.js";
