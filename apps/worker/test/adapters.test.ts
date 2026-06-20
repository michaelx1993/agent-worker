import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExecutionAdapter } from "../src/adapters";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server";
import { CodexCliAdapter } from "../src/adapters/codex-cli";
import {
  extractOpenHandsTraceRefsFromPayload,
  extractOpenHandsTraceRefs,
  mapOpenHandsTerminalStatus,
  OpenHandsCloudAdapter,
  parseOpenHandsList,
  repositoryNameFromGitUrl,
  summarizeOpenHandsEventLogPayload,
  summarizeOpenHandsConversationEvents,
} from "../src/adapters/openhands-cloud";

describe("worker execution adapters", () => {
  it("uses mock OpenHands to complete a run with the role default next state", async () => {
    const adapter = createExecutionAdapter("mock-openhands");

    await expect(
      adapter.execute({
        runId: "run-1",
        taskId: "task-1",
        identifier: "TOK-1",
        repositoryId: "repo-1",
        repositorySlug: "crs-src",
        repositoryGitUrl: "git@github.com:michaelx1993/crs-src.git",
        role: "development",
        leaseOwner: "worker-test",
      }),
    ).resolves.toEqual({
      status: "succeeded",
      summary: "Mock OpenHands adapter completed run.",
      nextState: "Code Review",
      conversation: {
        provider: "mock-openhands",
        conversationId: "mock-run-1",
        eventLogUri: "memory://mock-openhands/runs/run-1/events",
        eventCursor: "completed",
        uiUrl: "http://localhost/mock-openhands/runs/run-1",
      },
      events: [
        {
          eventType: "openhands.agent_message",
          message: "Mock OpenHands accepted TOK-1.",
          payload: {
            role: "development",
            repository: "crs-src",
          },
        },
        {
          eventType: "openhands.tool_call",
          message: "Mock OpenHands inspected workspace context.",
          payload: {
            workspacePath: null,
            workspaceStrategy: null,
          },
        },
        {
          eventType: "openhands.shell",
          message: "Mock OpenHands completed validation command.",
          payload: {
            command: "pnpm check",
            exitCode: 0,
          },
        },
      ],
      traces: [
        {
          provider: "mock-langfuse",
          traceId: "trace-run-1",
          generationId: "generation-run-1",
          model: "mock-openhands",
          inputTokens: 1,
          outputTokens: 16,
          costUsd: "0.000000",
          latencyMs: 1,
          uiUrl: "http://localhost/mock-langfuse/traces/trace-run-1",
        },
      ],
    });
  });

  it("does not invent a next state for non-executable gate roles", async () => {
    const adapter = createExecutionAdapter("mock-openhands");

    await expect(
      adapter.execute({
        runId: "run-1",
        taskId: "task-1",
        identifier: "TOK-1",
        repositoryId: "repo-1",
        repositorySlug: "crs-src",
        repositoryGitUrl: "https://github.com/michaelx1993/crs-src.git",
        role: "human_gate",
        leaseOwner: "worker-test",
      }),
    ).resolves.toEqual({
      status: "succeeded",
      summary: "Mock OpenHands adapter completed run.",
      conversation: {
        provider: "mock-openhands",
        conversationId: "mock-run-1",
        eventLogUri: "memory://mock-openhands/runs/run-1/events",
        eventCursor: "completed",
        uiUrl: "http://localhost/mock-openhands/runs/run-1",
      },
      events: expect.any(Array),
      traces: [
        {
          provider: "mock-langfuse",
          traceId: "trace-run-1",
          generationId: "generation-run-1",
          model: "mock-openhands",
          inputTokens: 1,
          outputTokens: 16,
          costUsd: "0.000000",
          latencyMs: 1,
          uiUrl: "http://localhost/mock-langfuse/traces/trace-run-1",
        },
      ],
    });
  });

  it("rejects unsupported adapter modes", () => {
    expect(() => createExecutionAdapter("unknown")).toThrow(
      "Unsupported worker execution adapter: unknown",
    );
  });

  it("runs Codex CLI adapter and maps JSONL output to run events", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "acp-codex-cli-test-"));
    const fakeCodex = join(tempDir, "fake-codex.mjs");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
import fs from "node:fs";
let stdin = "";
process.stdin.on("data", (chunk) => stdin += chunk);
process.stdin.on("end", () => {
  const outputIndex = process.argv.indexOf("--output-last-message");
  if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], "Codex fake completed.");
  console.log(JSON.stringify({ type: "agent_message", message: "fake accepted", stdinLength: stdin.length, argv: process.argv.slice(2) }));
});
`,
    );
    await chmod(fakeCodex, 0o700);

    try {
      const adapter = new CodexCliAdapter({
        command: fakeCodex,
        extraArgs: ["--model", "fake-model"],
        timeoutMs: 5_000,
      });

      await expect(
        adapter.execute({
          runId: "run-codex",
          taskId: "task-1",
          identifier: "TOK-7",
          repositoryId: "repo-1",
          repositorySlug: "aiworkspace",
          repositoryGitUrl: "git@github.com:michaelx1993/aiworkspace.git",
          workspacePath: tempDir,
          role: "development",
          leaseOwner: "worker-test",
          renderedPrompt: "请执行一个测试任务。",
        }),
      ).resolves.toMatchObject({
        status: "succeeded",
        summary: "Codex fake completed.",
        nextState: "Code Review",
        conversation: {
          provider: "codex-cli",
          conversationId: "codex-run-codex",
          eventCursor: "exit:0",
        },
        events: expect.arrayContaining([
          expect.objectContaining({ eventType: "codex.started" }),
          expect.objectContaining({
            eventType: "codex.agent_message",
            payload: expect.objectContaining({
              argv: expect.arrayContaining([
                "exec",
                "--json",
                "--output-last-message",
                "-C",
                tempDir,
                "--model",
                "fake-model",
                "-",
              ]),
            }),
          }),
          expect.objectContaining({ eventType: "codex.completed" }),
        ]),
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("defaults Codex CLI to gpt-5.5 with high reasoning effort", async () => {
    const previousArgs = process.env.WORKER_CODEX_ARGS_JSON;
    const previousWorkerModel = process.env.WORKER_CODEX_MODEL;
    const previousCodexModel = process.env.CODEX_MODEL;
    const previousReasoningEffort = process.env.WORKER_CODEX_REASONING_EFFORT;
    delete process.env.WORKER_CODEX_ARGS_JSON;
    delete process.env.WORKER_CODEX_MODEL;
    delete process.env.CODEX_MODEL;
    delete process.env.WORKER_CODEX_REASONING_EFFORT;

    const tempDir = await mkdtemp(join(tmpdir(), "acp-codex-cli-default-test-"));
    const fakeCodex = join(tempDir, "fake-codex-default.mjs");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
import fs from "node:fs";
process.stdin.resume();
process.stdin.on("end", () => {
  const outputIndex = process.argv.indexOf("--output-last-message");
  if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], "Default args captured.");
  console.log(JSON.stringify({ type: "agent_message", message: "captured defaults", argv: process.argv.slice(2) }));
});
`,
    );
    await chmod(fakeCodex, 0o700);

    try {
      const adapter = new CodexCliAdapter({
        command: fakeCodex,
        timeoutMs: 5_000,
      });
      const result = await adapter.execute({
        runId: "run-codex-defaults",
        taskId: "task-1",
        identifier: "TOK-DEFAULTS",
        repositoryId: "repo-1",
        repositorySlug: "aiworkspace",
        repositoryGitUrl: "git@github.com:michaelx1993/aiworkspace.git",
        workspacePath: tempDir,
        role: "development",
        leaseOwner: "worker-test",
      });

      expect(result.status).toBe("succeeded");
      expect(result.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "codex.agent_message",
            payload: expect.objectContaining({
              argv: expect.arrayContaining([
                "--dangerously-bypass-approvals-and-sandbox",
                "--config",
                "shell_environment_policy.inherit=all",
                "--config",
                "model_reasoning_effort=high",
                "-m",
                "gpt-5.5",
              ]),
            }),
          }),
        ]),
      );
    } finally {
      restoreEnv("WORKER_CODEX_ARGS_JSON", previousArgs);
      restoreEnv("WORKER_CODEX_MODEL", previousWorkerModel);
      restoreEnv("CODEX_MODEL", previousCodexModel);
      restoreEnv("WORKER_CODEX_REASONING_EFFORT", previousReasoningEffort);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("normalizes Codex app-server event methods into readable high-signal events", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "acp-codex-cli-method-test-"));
    const fakeCodex = join(tempDir, "fake-codex-methods.mjs");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
import fs from "node:fs";
process.stdin.resume();
process.stdin.on("end", () => {
  const outputIndex = process.argv.indexOf("--output-last-message");
  if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], "Method events captured.");
  console.log(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "writing progress update" } }));
  console.log(JSON.stringify({ method: "codex/event/agent_message_delta", params: { msg: { payload: { delta: "token=ghp_methodsecret1234567890" } } } }));
  console.log(JSON.stringify({ method: "item/reasoning/textDelta", params: { textDelta: "compare retry paths" } }));
  console.log(JSON.stringify({ method: "item/commandExecution/outputDelta", params: { outputDelta: "pnpm test passed" } }));
  console.log(JSON.stringify({ method: "item/fileChange/outputDelta", params: { outputDelta: "edited app.ts" } }));
});
`,
    );
    await chmod(fakeCodex, 0o700);

    try {
      const adapter = new CodexCliAdapter({
        command: fakeCodex,
        extraArgs: [],
        timeoutMs: 5_000,
      });
      const result = await adapter.execute({
        runId: "run-codex-methods",
        taskId: "task-1",
        identifier: "TOK-METHODS",
        repositoryId: "repo-1",
        repositorySlug: "aiworkspace",
        repositoryGitUrl: "git@github.com:michaelx1993/aiworkspace.git",
        workspacePath: tempDir,
        role: "development",
        leaseOwner: "worker-test",
      });

      expect(result.status).toBe("succeeded");
      expect(result.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "codex.agent_message",
            message: "agent message streaming: writing progress update",
          }),
          expect.objectContaining({
            eventType: "codex.agent_message",
            message: expect.stringContaining("[REDACTED"),
          }),
          expect.objectContaining({
            eventType: "codex.reasoning",
            message: "reasoning streaming: compare retry paths",
          }),
          expect.objectContaining({
            eventType: "codex.exec_command",
            message: "command output streaming: pnpm test passed",
          }),
          expect.objectContaining({
            eventType: "codex.file_operation",
            message: "file change output streaming: edited app.ts",
          }),
        ]),
      );
      expect(JSON.stringify(result.events)).not.toContain("ghp_methodsecret1234567890");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs Codex app-server adapter through initialize, thread, and turn lifecycle", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "acp-codex-app-server-test-"));
    const fakeCodex = join(tempDir, "fake-codex-app-server.mjs");
    const traceFile = join(tempDir, "requests.jsonl");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const traceFile = process.env.FAKE_CODEX_APP_SERVER_TRACE;
const rl = readline.createInterface({ input: process.stdin });

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}

rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (traceFile) fs.appendFileSync(traceFile, JSON.stringify(request) + "\\n");
  if (request.method === "initialize") {
    send({ id: request.id, result: { serverInfo: { name: "fake-codex" } } });
  } else if (request.method === "thread/start") {
    send({ id: request.id, result: { thread: { id: "thread-123" } } });
  } else if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "turn-456" } } });
    send({ method: "codex/event/agent_message_delta", params: { msg: { payload: { delta: "implemented app-server path" } } } });
    send({ method: "item/commandExecution/outputDelta", params: { outputDelta: "pnpm test passed" } });
    send({ method: "turn/completed", params: { turn: { status: "completed" } } });
    process.exit(0);
  }
});
`,
    );
    await chmod(fakeCodex, 0o700);

    const previousTrace = process.env.FAKE_CODEX_APP_SERVER_TRACE;
    process.env.FAKE_CODEX_APP_SERVER_TRACE = traceFile;

    try {
      const adapter = new CodexAppServerAdapter({
        command: fakeCodex,
        args: ["app-server"],
        timeoutMs: 5_000,
      });
      const result = await adapter.execute({
        runId: "run-codex-app-server",
        taskId: "task-1",
        identifier: "TOK-APP-SERVER",
        repositoryId: "repo-1",
        repositorySlug: "aiworkspace",
        repositoryGitUrl: "git@github.com:michaelx1993/aiworkspace.git",
        workspacePath: tempDir,
        role: "development",
        leaseOwner: "worker-test",
        renderedPrompt: "Run the app-server adapter test.",
      });

      expect(result).toMatchObject({
        status: "succeeded",
        nextState: "Code Review",
        conversation: {
          provider: "codex-app-server",
          conversationId: "thread-123/turns/turn-456",
          eventLogUri: "process://codex-app-server/threads/thread-123/turns/turn-456",
          eventCursor: "completed",
        },
        events: expect.arrayContaining([
          expect.objectContaining({ eventType: "codex.app_server_started" }),
          expect.objectContaining({
            eventType: "codex.agent_message",
            message: "agent message streaming: implemented app-server path",
          }),
          expect.objectContaining({
            eventType: "codex.exec_command",
            message: "command output streaming: pnpm test passed",
          }),
          expect.objectContaining({ eventType: "codex.turn_completed" }),
          expect.objectContaining({ eventType: "codex.completed" }),
        ]),
      });
    } finally {
      restoreEnv("FAKE_CODEX_APP_SERVER_TRACE", previousTrace);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reuses a previous Codex app-server thread for a follow-up turn", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "acp-codex-app-server-reuse-test-"));
    const fakeCodex = join(tempDir, "fake-codex-app-server-reuse.mjs");
    const traceFile = join(tempDir, "requests.jsonl");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const traceFile = process.env.FAKE_CODEX_APP_SERVER_TRACE;
const rl = readline.createInterface({ input: process.stdin });

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}

rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (traceFile) fs.appendFileSync(traceFile, JSON.stringify(request) + "\\n");
  if (request.method === "initialize") {
    send({ id: request.id, result: { serverInfo: { name: "fake-codex" } } });
  } else if (request.method === "thread/start") {
    send({ id: request.id, error: { message: "thread/start should not be called for reuse" } });
  } else if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "turn-followup" } } });
    send({ method: "codex/event/agent_message_delta", params: { msg: { payload: { delta: "continued existing thread" } } } });
    send({ method: "turn/completed", params: { turn: { status: "completed" } } });
    process.exit(0);
  }
});
`,
    );
    await chmod(fakeCodex, 0o700);

    const previousTrace = process.env.FAKE_CODEX_APP_SERVER_TRACE;
    process.env.FAKE_CODEX_APP_SERVER_TRACE = traceFile;

    try {
      const adapter = new CodexAppServerAdapter({
        command: fakeCodex,
        args: ["app-server"],
        timeoutMs: 5_000,
      });
      const result = await adapter.execute({
        runId: "run-codex-app-server-reuse",
        taskId: "task-1",
        identifier: "TOK-APP-SERVER-2",
        repositoryId: "repo-1",
        repositorySlug: "aiworkspace",
        repositoryGitUrl: "git@github.com:michaelx1993/aiworkspace.git",
        workspacePath: tempDir,
        role: "development",
        leaseOwner: "worker-test",
        renderedPrompt: "Continue the app-server adapter test.",
        previousConversation: {
          provider: "codex-app-server",
          conversationId: "thread-123/turns/turn-456",
          eventLogUri: "process://codex-app-server/threads/thread-123/turns/turn-456",
          eventCursor: "completed",
        },
      });

      const requests = (await readFile(traceFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method?: string; params?: { threadId?: string } });
      expect(requests.some((request) => request.method === "thread/start")).toBe(false);
      expect(requests.find((request) => request.method === "turn/start")?.params?.threadId).toBe(
        "thread-123",
      );
      expect(result).toMatchObject({
        status: "succeeded",
        conversation: {
          provider: "codex-app-server",
          conversationId: "thread-123/turns/turn-followup",
          eventLogUri: "process://codex-app-server/threads/thread-123/turns/turn-followup",
        },
        events: expect.arrayContaining([
          expect.objectContaining({ eventType: "codex.thread_reused" }),
          expect.objectContaining({
            eventType: "codex.agent_message",
            message: "agent message streaming: continued existing thread",
          }),
        ]),
      });
    } finally {
      restoreEnv("FAKE_CODEX_APP_SERVER_TRACE", previousTrace);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a persistent Codex app-server process across follow-up turns", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "acp-codex-app-server-persistent-test-"));
    const fakeCodex = join(tempDir, "fake-codex-app-server-persistent.mjs");
    const traceFile = join(tempDir, "requests.jsonl");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const traceFile = process.env.FAKE_CODEX_APP_SERVER_TRACE;
const rl = readline.createInterface({ input: process.stdin });
let turnCount = 0;

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}

rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (traceFile) fs.appendFileSync(traceFile, JSON.stringify({ pid: process.pid, ...request }) + "\\n");
  if (request.method === "initialize") {
    send({ id: request.id, result: { serverInfo: { name: "fake-codex" } } });
  } else if (request.method === "thread/start") {
    send({ id: request.id, result: { thread: { id: "thread-persistent" } } });
  } else if (request.method === "turn/start") {
    turnCount += 1;
    send({ id: request.id, result: { turn: { id: "turn-" + turnCount } } });
    send({ method: "codex/event/agent_message_delta", params: { msg: { payload: { delta: "persistent turn " + turnCount } } } });
    send({ method: "turn/completed", params: { turn: { status: "completed" } } });
  }
});
`,
    );
    await chmod(fakeCodex, 0o700);

    const previousTrace = process.env.FAKE_CODEX_APP_SERVER_TRACE;
    process.env.FAKE_CODEX_APP_SERVER_TRACE = traceFile;

    try {
      const adapter = new CodexAppServerAdapter({
        command: fakeCodex,
        args: ["app-server"],
        timeoutMs: 5_000,
        persistent: true,
      });
      const first = await adapter.execute({
        runId: "run-codex-app-server-persistent-1",
        taskId: "task-1",
        identifier: "TOK-APP-SERVER-PERSIST-1",
        repositoryId: "repo-1",
        repositorySlug: "aiworkspace",
        repositoryGitUrl: "git@github.com:michaelx1993/aiworkspace.git",
        workspacePath: tempDir,
        role: "development",
        leaseOwner: "worker-test",
        renderedPrompt: "Start persistent app-server adapter test.",
      });
      const second = await adapter.execute({
        runId: "run-codex-app-server-persistent-2",
        taskId: "task-1",
        identifier: "TOK-APP-SERVER-PERSIST-2",
        repositoryId: "repo-1",
        repositorySlug: "aiworkspace",
        repositoryGitUrl: "git@github.com:michaelx1993/aiworkspace.git",
        workspacePath: tempDir,
        role: "development",
        leaseOwner: "worker-test",
        renderedPrompt: "Continue persistent app-server adapter test.",
        previousConversation:
          first.conversation?.provider === "codex-app-server" ? first.conversation : undefined,
      });
      await adapter.dispose();

      const requests = (await readFile(traceFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { pid: number; method?: string; params?: { threadId?: string } },
        );
      expect(new Set(requests.map((request) => request.pid)).size).toBe(1);
      expect(requests.filter((request) => request.method === "initialize")).toHaveLength(1);
      expect(requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
      expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
      expect(requests.at(-1)?.params?.threadId).toBe("thread-persistent");
      expect(first).toMatchObject({
        status: "succeeded",
        conversation: {
          provider: "codex-app-server",
          conversationId: "thread-persistent/turns/turn-1",
        },
      });
      expect(second).toMatchObject({
        status: "succeeded",
        conversation: {
          provider: "codex-app-server",
          conversationId: "thread-persistent/turns/turn-2",
        },
        events: expect.arrayContaining([
          expect.objectContaining({ eventType: "codex.thread_reused" }),
          expect.objectContaining({
            eventType: "codex.agent_message",
            message: "agent message streaming: persistent turn 2",
          }),
        ]),
      });
      expect(second.events).not.toContainEqual(
        expect.objectContaining({
          eventType: "codex.agent_message",
          message: "agent message streaming: persistent turn 1",
        }),
      );
    } finally {
      restoreEnv("FAKE_CODEX_APP_SERVER_TRACE", previousTrace);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a failed Codex CLI result with a spawn error event when the command cannot start", async () => {
    const adapter = new CodexCliAdapter({
      command: "/definitely/missing/acp-codex",
      extraArgs: [],
      timeoutMs: 5_000,
    });

    await expect(
      adapter.execute({
        runId: "run-codex-spawn-error",
        taskId: "task-1",
        identifier: "TOK-SPAWN",
        repositoryId: "repo-1",
        repositorySlug: "aiworkspace",
        repositoryGitUrl: "git@github.com:michaelx1993/aiworkspace.git",
        role: "development",
        leaseOwner: "worker-test",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("Codex CLI failed to start"),
      retryable: true,
      conversation: {
        provider: "codex-cli",
        eventCursor: "spawn-error",
      },
      events: expect.arrayContaining([
        expect.objectContaining({ eventType: "codex.spawn_error" }),
        expect.objectContaining({ eventType: "codex.completed" }),
      ]),
    });
  });

  it("returns a failed Codex CLI result with a timeout event when execution exceeds the limit", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "acp-codex-cli-timeout-test-"));
    const fakeCodex = join(tempDir, "fake-codex-timeout.mjs");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
setInterval(() => {}, 1000);
`,
    );
    await chmod(fakeCodex, 0o700);

    try {
      const adapter = new CodexCliAdapter({
        command: fakeCodex,
        extraArgs: [],
        timeoutMs: 50,
      });

      await expect(
        adapter.execute({
          runId: "run-codex-timeout",
          taskId: "task-1",
          identifier: "TOK-TIMEOUT",
          repositoryId: "repo-1",
          repositorySlug: "aiworkspace",
          repositoryGitUrl: "git@github.com:michaelx1993/aiworkspace.git",
          workspacePath: tempDir,
          role: "development",
          leaseOwner: "worker-test",
        }),
      ).resolves.toMatchObject({
        status: "failed",
        reason: "Codex CLI timed out after 50ms.",
        retryable: true,
        conversation: {
          provider: "codex-cli",
          eventCursor: "timeout",
        },
        events: expect.arrayContaining([
          expect.objectContaining({
            eventType: "codex.timeout",
            payload: { timeoutMs: 50 },
          }),
          expect.objectContaining({ eventType: "codex.completed" }),
        ]),
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("caps Codex CLI stdout events and redacts captured stderr", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "acp-codex-cli-output-test-"));
    const fakeCodex = join(tempDir, "fake-codex-output.mjs");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
for (let index = 0; index < 30; index += 1) {
  if (index === 0) {
    console.log(JSON.stringify({ type: "agent_message", message: "token=ghp_stdoutsecret1234567890", nested: { api_key: "sk_stdoutsecret1234567890" } }));
  } else if (index === 1) {
    console.log("plain Bearer stdout.secret.token");
  } else {
    console.log(index % 2 === 0 ? JSON.stringify({ type: "agent_message", message: "event " + index }) : "plain output " + index);
  }
}
console.error("token=ghp_1234567890abcdefghijklmnop secret=my-secret-value Bearer abc.def.ghi");
process.exit(1);
`,
    );
    await chmod(fakeCodex, 0o700);

    try {
      const adapter = new CodexCliAdapter({
        command: fakeCodex,
        extraArgs: [],
        timeoutMs: 5_000,
      });

      const result = await adapter.execute({
        runId: "run-codex-output",
        taskId: "task-1",
        identifier: "TOK-OUTPUT",
        repositoryId: "repo-1",
        repositorySlug: "aiworkspace",
        repositoryGitUrl: "git@github.com:michaelx1993/aiworkspace.git",
        workspacePath: tempDir,
        role: "development",
        leaseOwner: "worker-test",
      });

      expect(result.status).toBe("failed");
      expect(result.events?.filter((event) => event.eventType === "codex.output")).toHaveLength(12);
      expect(
        result.events?.filter((event) => event.eventType === "codex.agent_message"),
      ).toHaveLength(13);
      expect(result.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "codex.events_truncated",
            payload: { totalEvents: 30, storedEvents: 25 },
          }),
        ]),
      );
      const stderrEvent = result.events?.find((event) => event.eventType === "codex.stderr");
      expect(JSON.stringify(result.events)).not.toContain("ghp_stdoutsecret1234567890");
      expect(JSON.stringify(result.events)).not.toContain("sk_stdoutsecret1234567890");
      expect(JSON.stringify(result.events)).not.toContain("stdout.secret.token");
      expect(JSON.stringify(stderrEvent)).not.toContain("ghp_1234567890abcdefghijklmnop");
      expect(JSON.stringify(stderrEvent)).not.toContain("my-secret-value");
      expect(JSON.stringify(stderrEvent)).not.toContain("abc.def.ghi");
      expect(stderrEvent).toMatchObject({
        payload: { stderr: expect.stringContaining("[REDACTED") },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("OpenHands Cloud adapter", () => {
  it("starts and polls a cloud conversation until finished", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);

      if (String(url).endsWith("/api/v1/app-conversations")) {
        return jsonResponse({ id: "start-1", status: "WORKING" });
      }

      if (String(url).includes("/api/v1/app-conversations/start-tasks")) {
        return jsonResponse([{ id: "start-1", status: "READY", app_conversation_id: "conv-1" }]);
      }

      return jsonResponse([
        {
          id: "conv-1",
          sandbox_status: "RUNNING",
          execution_status: "finished",
          traces: [
            {
              provider: "langfuse",
              trace_id: "trace-conv-1",
              generation_id: "generation-conv-1",
              model: "gpt-5.5",
              input_tokens: 123,
              output_tokens: 45,
              cost_usd: "0.002300",
              latency_ms: 789,
              ui_url: "https://langfuse.example.com/project/p/traces/trace-conv-1",
            },
          ],
          events: [
            {
              id: "event-1",
              type: "message",
              role: "assistant",
              content: "我会先检查代码。",
            },
            {
              id: "event-2",
              type: "tool_call",
              name: "read_file",
              action: "read",
            },
            {
              id: "event-3",
              type: "shell",
              command: "pnpm check",
              exit_code: 0,
            },
          ],
        },
      ]);
    };
    const adapter = new OpenHandsCloudAdapter({
      apiKey: "test-key",
      baseUrl: "https://app.all-hands.dev/",
      fetchImpl: fetchImpl as typeof fetch,
      sleepImpl: async () => {},
    });

    await expect(
      adapter.execute({
        runId: "run-1",
        taskId: "task-1",
        identifier: "TOK-1",
        repositoryId: "repo-1",
        repositorySlug: "crs-src",
        repositoryGitUrl: "git@github.com:michaelx1993/crs-src.git",
        role: "development",
        leaseOwner: "worker-test",
        renderedPrompt: "实现任务",
        promptReleaseId: "prompt-release-1",
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      nextState: "Code Review",
      conversation: {
        provider: "openhands-cloud",
        conversationId: "conv-1",
        eventCursor: "finished",
        uiUrl: "https://app.all-hands.dev/conversations/conv-1",
      },
      events: [
        {
          eventType: "openhands.agent_message",
          message: "我会先检查代码。",
        },
        {
          eventType: "openhands.file_operation",
          message: "read read_file",
        },
        {
          eventType: "openhands.shell",
          message: "pnpm check",
        },
        {
          eventType: "openhands.status",
          message: "OpenHands Cloud conversation conv-1 finished.",
          payload: {
            id: "conv-1",
            sandbox_status: "RUNNING",
            execution_status: "finished",
          },
        },
      ],
      traces: [
        {
          provider: "langfuse",
          traceId: "trace-conv-1",
          generationId: "generation-conv-1",
          model: "gpt-5.5",
          promptReleaseId: "prompt-release-1",
          inputTokens: 123,
          outputTokens: 45,
          costUsd: "0.002300",
          latencyMs: 789,
          uiUrl: "https://langfuse.example.com/project/p/traces/trace-conv-1",
        },
      ],
    });

    expect(calls).toEqual([
      "POST https://app.all-hands.dev/api/v1/app-conversations",
      "GET https://app.all-hands.dev/api/v1/app-conversations/start-tasks?ids=start-1",
      "GET https://app.all-hands.dev/api/v1/app-conversations?ids=conv-1",
    ]);
  });

  it("accepts paginated OpenHands list responses", async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/v1/app-conversations")) {
        return jsonResponse({ id: "start-1", status: "WORKING" });
      }

      if (String(url).includes("/api/v1/app-conversations/start-tasks")) {
        return jsonResponse({
          results: [{ id: "start-1", status: "READY", app_conversation_id: "conv-1" }],
        });
      }

      return jsonResponse({
        results: [
          {
            id: "conv-1",
            sandbox_status: "RUNNING",
            execution_status: "finished",
            messages: [{ type: "message", role: "assistant", content: "完成。" }],
          },
        ],
      });
    };
    const adapter = new OpenHandsCloudAdapter({
      apiKey: "test-key",
      baseUrl: "https://app.all-hands.dev",
      fetchImpl: fetchImpl as typeof fetch,
      sleepImpl: async () => {},
    });

    await expect(
      adapter.execute({
        runId: "run-1",
        taskId: "task-1",
        identifier: "TOK-1",
        repositoryId: "repo-1",
        repositorySlug: "crs-src",
        repositoryGitUrl: "git@github.com:michaelx1993/crs-src.git",
        role: "development",
        leaseOwner: "worker-test",
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      nextState: "Code Review",
      conversation: {
        conversationId: "conv-1",
      },
      events: [
        {
          eventType: "openhands.agent_message",
          message: "完成。",
        },
        {
          eventType: "openhands.status",
        },
      ],
    });
  });

  it("treats uppercase OpenHands completed status as terminal success", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);

      if (String(url).endsWith("/api/v1/app-conversations")) {
        return jsonResponse({ id: "start-1", status: "READY", app_conversation_id: "conv-1" });
      }

      return jsonResponse([
        {
          id: "conv-1",
          sandbox_status: "RUNNING",
          execution_status: "COMPLETED",
          messages: [{ type: "message", role: "assistant", content: "完成。" }],
        },
      ]);
    };
    const adapter = new OpenHandsCloudAdapter({
      apiKey: "test-key",
      baseUrl: "https://app.all-hands.dev",
      fetchImpl: fetchImpl as typeof fetch,
      sleepImpl: async () => {},
      executionTimeoutMs: 1,
    });

    await expect(
      adapter.execute({
        runId: "run-1",
        taskId: "task-1",
        identifier: "TOK-1",
        repositoryId: "repo-1",
        repositorySlug: "crs-src",
        repositoryGitUrl: "git@github.com:michaelx1993/crs-src.git",
        role: "development",
        leaseOwner: "worker-test",
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      nextState: "Code Review",
      conversation: {
        conversationId: "conv-1",
        eventCursor: "COMPLETED",
      },
    });

    expect(calls).toEqual([
      "POST https://app.all-hands.dev/api/v1/app-conversations",
      "GET https://app.all-hands.dev/api/v1/app-conversations?ids=conv-1",
    ]);
  });

  it("fetches a same-origin OpenHands event log and summarizes it", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);

      if (String(url).endsWith("/api/v1/app-conversations")) {
        return jsonResponse({ id: "start-1", status: "READY", app_conversation_id: "conv-1" });
      }

      if (String(url).endsWith("/api/v1/app-conversations/conv-1/events")) {
        return jsonResponse({
          data: [
            {
              type: "message",
              role: "assistant",
              content: "开始读取事件日志。",
            },
            {
              type: "shell",
              command: "pnpm check",
              exit_code: 0,
              traceId: "trace-event-log-1",
              generationId: "generation-event-log-1",
              model: "gpt-5.5",
              inputTokens: 20,
              outputTokens: 8,
            },
          ],
        });
      }

      return jsonResponse([
        {
          id: "conv-1",
          sandbox_status: "RUNNING",
          execution_status: "finished",
          event_log_url: "/api/v1/app-conversations/conv-1/events",
          messages: [{ type: "message", role: "assistant", content: "payload fallback" }],
        },
      ]);
    };
    const adapter = new OpenHandsCloudAdapter({
      apiKey: "test-key",
      baseUrl: "https://app.all-hands.dev",
      fetchImpl: fetchImpl as typeof fetch,
      sleepImpl: async () => {},
    });

    await expect(
      adapter.execute({
        runId: "run-1",
        taskId: "task-1",
        identifier: "TOK-1",
        repositoryId: "repo-1",
        repositorySlug: "crs-src",
        repositoryGitUrl: "git@github.com:michaelx1993/crs-src.git",
        role: "development",
        leaseOwner: "worker-test",
        promptReleaseId: "prompt-release-1",
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      conversation: {
        eventLogUri: "https://app.all-hands.dev/api/v1/app-conversations/conv-1/events",
      },
      events: [
        {
          eventType: "openhands.agent_message",
          message: "开始读取事件日志。",
        },
        {
          eventType: "openhands.shell",
          message: "pnpm check",
        },
        {
          eventType: "openhands.status",
        },
      ],
      traces: [
        {
          provider: "openhands-langfuse",
          traceId: "trace-event-log-1",
          generationId: "generation-event-log-1",
          promptReleaseId: "prompt-release-1",
          model: "gpt-5.5",
          inputTokens: 20,
          outputTokens: 8,
        },
      ],
    });

    expect(calls).toEqual([
      "POST https://app.all-hands.dev/api/v1/app-conversations",
      "GET https://app.all-hands.dev/api/v1/app-conversations?ids=conv-1",
      "GET https://app.all-hands.dev/api/v1/app-conversations/conv-1/events",
    ]);
  });

  it("uses configured OpenHands event log path template when payload has no event URL", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);

      if (String(url).endsWith("/api/v1/app-conversations")) {
        return jsonResponse({ id: "start-1", status: "READY", app_conversation_id: "conv-1" });
      }

      if (String(url).endsWith("/api/v1/app-conversations/conv-1/events")) {
        return jsonResponse({
          items: [
            {
              event_type: "message",
              role: "assistant",
              content: "从配置的 event API 读取。",
            },
          ],
        });
      }

      return jsonResponse([
        {
          id: "conv-1",
          sandbox_status: "RUNNING",
          execution_status: "finished",
          messages: [{ type: "message", role: "assistant", content: "payload fallback" }],
        },
      ]);
    };
    const adapter = new OpenHandsCloudAdapter({
      apiKey: "test-key",
      baseUrl: "https://app.all-hands.dev",
      eventLogPathTemplate: "/api/v1/app-conversations/{conversationId}/events",
      fetchImpl: fetchImpl as typeof fetch,
      sleepImpl: async () => {},
    });

    await expect(
      adapter.execute({
        runId: "run-1",
        taskId: "task-1",
        identifier: "TOK-1",
        repositoryId: "repo-1",
        repositorySlug: "crs-src",
        repositoryGitUrl: "git@github.com:michaelx1993/crs-src.git",
        role: "development",
        leaseOwner: "worker-test",
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      conversation: {
        eventLogUri: "https://app.all-hands.dev/api/v1/app-conversations/conv-1/events",
      },
      events: [
        {
          eventType: "openhands.agent_message",
          message: "从配置的 event API 读取。",
        },
        {
          eventType: "openhands.status",
        },
      ],
    });

    expect(calls).toEqual([
      "POST https://app.all-hands.dev/api/v1/app-conversations",
      "GET https://app.all-hands.dev/api/v1/app-conversations?ids=conv-1",
      "GET https://app.all-hands.dev/api/v1/app-conversations/conv-1/events",
    ]);
  });

  it("falls back to conversation payload when OpenHands event log fetch fails", async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/v1/app-conversations")) {
        return jsonResponse({ id: "start-1", status: "READY", app_conversation_id: "conv-1" });
      }

      if (String(url).endsWith("/api/v1/app-conversations/conv-1/events")) {
        return new Response("nope", { status: 503 });
      }

      return jsonResponse([
        {
          id: "conv-1",
          sandbox_status: "RUNNING",
          execution_status: "finished",
          event_log_url: "/api/v1/app-conversations/conv-1/events",
          messages: [{ type: "message", role: "assistant", content: "payload fallback" }],
        },
      ]);
    };
    const adapter = new OpenHandsCloudAdapter({
      apiKey: "test-key",
      baseUrl: "https://app.all-hands.dev",
      fetchImpl: fetchImpl as typeof fetch,
      sleepImpl: async () => {},
    });

    await expect(
      adapter.execute({
        runId: "run-1",
        taskId: "task-1",
        identifier: "TOK-1",
        repositoryId: "repo-1",
        repositorySlug: "crs-src",
        repositoryGitUrl: "git@github.com:michaelx1993/crs-src.git",
        role: "development",
        leaseOwner: "worker-test",
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      events: [
        {
          eventType: "openhands.agent_message",
          message: "payload fallback",
        },
        {
          eventType: "openhands.event_log_warning",
          message: "OpenHands event log fetch failed; using conversation payload summary.",
        },
        {
          eventType: "openhands.status",
        },
      ],
    });
  });

  it("summarizes OpenHands event payloads without storing full raw logs", () => {
    expect(
      summarizeOpenHandsConversationEvents({
        id: "conv-1",
        execution_status: "finished",
        messages: [
          {
            type: "message",
            role: "assistant",
            content: "完成实现。",
            hidden: "not-copied",
          },
          {
            type: "tool_call",
            action: "edit",
            name: "apply_patch",
            content: "x".repeat(2500),
          },
        ],
      }),
    ).toEqual([
      {
        eventType: "openhands.agent_message",
        message: "完成实现。",
        payload: {
          type: "message",
          role: "assistant",
          content: "完成实现。",
        },
      },
      {
        eventType: "openhands.file_operation",
        message: "edit apply_patch",
        payload: {
          type: "tool_call",
          action: "edit",
          name: "apply_patch",
          content: expect.stringMatching(/^x+…$/),
        },
      },
    ]);
  });

  it("summarizes OpenHands file operation events separately from generic tools", () => {
    expect(
      summarizeOpenHandsEventLogPayload({
        data: [
          {
            type: "file_write",
            action: "write",
            path: "apps/web/app/page.tsx",
            diff: "+return <main />",
          },
          {
            type: "tool_call",
            name: "browser_snapshot",
            action: "inspect",
          },
        ],
      }),
    ).toEqual([
      {
        eventType: "openhands.file_operation",
        message: "write apps/web/app/page.tsx",
        payload: {
          type: "file_write",
          action: "write",
          path: "apps/web/app/page.tsx",
          diff: "+return <main />",
        },
      },
      {
        eventType: "openhands.tool_call",
        message: "inspect",
        payload: {
          type: "tool_call",
          action: "inspect",
          name: "browser_snapshot",
        },
      },
    ]);
  });

  it("redacts secrets from OpenHands event summaries before storing local payloads", () => {
    expect(
      summarizeOpenHandsConversationEvents({
        id: "conv-1",
        execution_status: "finished",
        messages: [
          {
            type: "terminal",
            command:
              'OPENAI_API_KEY=sk-proj_1234567890abcdef curl -H "Authorization: Bearer token123456789" https://example.test',
          },
          {
            type: "message",
            content: [
              { type: "text", text: "password=hunter2" },
              { type: "text", text: "token: ghp_1234567890abcdef" },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        eventType: "openhands.shell",
        message:
          'OPENAI_API_KEY=<redacted> curl -H "Authorization: Bearer <redacted>" https://example.test',
        payload: {
          type: "terminal",
          command:
            'OPENAI_API_KEY=<redacted> curl -H "Authorization: Bearer <redacted>" https://example.test',
        },
      },
      {
        eventType: "openhands.agent_message",
        message: "password=<redacted> token=<redacted>",
        payload: {
          type: "message",
          content: "password=<redacted> token=<redacted>",
        },
      },
    ]);
  });

  it("summarizes standalone OpenHands event log payloads", () => {
    expect(
      summarizeOpenHandsEventLogPayload({
        data: [
          {
            type: "message",
            role: "assistant",
            content: "事件日志消息。",
          },
          {
            type: "terminal",
            command: "pnpm test",
            exit_code: 0,
          },
        ],
      }),
    ).toEqual([
      {
        eventType: "openhands.agent_message",
        message: "事件日志消息。",
        payload: {
          type: "message",
          role: "assistant",
          content: "事件日志消息。",
        },
      },
      {
        eventType: "openhands.shell",
        message: "pnpm test",
        payload: {
          type: "terminal",
          command: "pnpm test",
          exit_code: 0,
        },
      },
    ]);
  });

  it("extracts trace refs from nested OpenHands event payloads", () => {
    expect(
      extractOpenHandsTraceRefs(
        {
          id: "conv-1",
          execution_status: "finished",
          messages: {
            results: [
              {
                type: "llm",
                traceId: "trace-event-1",
                generationId: "generation-event-1",
                model_name: "gpt-5.5",
                inputTokens: "10",
                outputTokens: "4",
                cost: 0.00042,
                latencyMs: "250",
                traceUrl: "https://langfuse.example.com/project/p/traces/trace-event-1",
              },
            ],
          },
        },
        "prompt-release-1",
      ),
    ).toEqual([
      {
        provider: "openhands-langfuse",
        traceId: "trace-event-1",
        generationId: "generation-event-1",
        model: "gpt-5.5",
        promptReleaseId: "prompt-release-1",
        inputTokens: 10,
        outputTokens: 4,
        costUsd: "0.000420",
        latencyMs: 250,
        uiUrl: "https://langfuse.example.com/project/p/traces/trace-event-1",
      },
    ]);
  });

  it("summarizes OpenHands LLM generation events with prompt output and usage", () => {
    expect(
      summarizeOpenHandsEventLogPayload({
        data: [
          {
            type: "llm",
            trace_id: "trace-log-1",
            generation_id: "generation-log-1",
            model_name: "gpt-5.5",
            prompt: "Use api_key=secret-value to call the model",
            response: "实现完成，Bearer secret-token",
            input_tokens: 10,
            output_tokens: 4,
            cost_usd: "0.000420",
            latency_ms: 250,
            trace_url: "https://langfuse.example.com/project/p/traces/trace-log-1",
          },
        ],
      }),
    ).toEqual([
      {
        eventType: "openhands.llm_generation",
        message: "model=gpt-5.5 实现完成，Bearer <redacted>",
        payload: {
          type: "llm",
          trace_id: "trace-log-1",
          generation_id: "generation-log-1",
          model_name: "gpt-5.5",
          prompt: "Use api_key=<redacted> to call the model",
          response: "实现完成，Bearer <redacted>",
          input_tokens: 10,
          output_tokens: 4,
          cost_usd: "0.000420",
          latency_ms: 250,
          trace_url: "https://langfuse.example.com/project/p/traces/trace-log-1",
        },
      },
    ]);
  });

  it("summarizes nested OpenHands LLM chat payloads without storing raw secret objects", () => {
    expect(
      summarizeOpenHandsEventLogPayload({
        data: [
          {
            type: "llm_generation",
            model: "gpt-5.5",
            input: {
              messages: [
                { role: "system", content: "使用 token=secret-token 初始化。" },
                { role: "user", content: [{ type: "text", text: "请修复 bug。" }] },
              ],
            },
            output: {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "已修复，OPENAI_API_KEY=sk-proj_1234567890abcdef。",
                  },
                },
              ],
            },
            inputTokens: 42,
            outputTokens: 12,
          },
        ],
      }),
    ).toEqual([
      {
        eventType: "openhands.llm_generation",
        message: "model=gpt-5.5 已修复，OPENAI_API_KEY=<redacted>",
        payload: {
          type: "llm_generation",
          model: "gpt-5.5",
          input: "使用 token=<redacted> 初始化。 请修复 bug。",
          output: "已修复，OPENAI_API_KEY=<redacted>",
          inputTokens: 42,
          outputTokens: 12,
        },
      },
    ]);
  });

  it("extracts trace refs from standalone OpenHands event log payloads", () => {
    expect(
      extractOpenHandsTraceRefsFromPayload(
        {
          data: [
            {
              type: "llm",
              trace_id: "trace-log-1",
              generation_id: "generation-log-1",
              provider: "langfuse",
            },
          ],
        },
        "prompt-release-1",
      ),
    ).toEqual([
      {
        provider: "langfuse",
        traceId: "trace-log-1",
        generationId: "generation-log-1",
        promptReleaseId: "prompt-release-1",
      },
    ]);
  });

  it("summarizes nested OpenHands event containers and content parts", () => {
    expect(
      summarizeOpenHandsConversationEvents({
        id: "conv-1",
        execution_status: "finished",
        event_log: {
          events: {
            items: [
              {
                event_type: "message",
                role: "assistant",
                content: [
                  { type: "text", text: "先看任务。" },
                  { type: "text", text: "再跑测试。" },
                ],
              },
              {
                event_type: "terminal",
                command: "pnpm check",
                exit_code: 0,
              },
            ],
          },
        },
      }),
    ).toEqual([
      {
        eventType: "openhands.agent_message",
        message: "先看任务。 再跑测试。",
        payload: {
          event_type: "message",
          role: "assistant",
          content: "先看任务。 再跑测试。",
        },
      },
      {
        eventType: "openhands.shell",
        message: "pnpm check",
        payload: {
          event_type: "terminal",
          command: "pnpm check",
          exit_code: 0,
        },
      },
    ]);
  });

  it("maps OpenHands waiting_for_confirmation to a non-retryable failure", async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/v1/app-conversations")) {
        return jsonResponse({ id: "start-1", status: "READY", app_conversation_id: "conv-1" });
      }

      return jsonResponse([
        {
          id: "conv-1",
          sandbox_status: "RUNNING",
          execution_status: "waiting_for_confirmation",
        },
      ]);
    };
    const adapter = new OpenHandsCloudAdapter({
      apiKey: "test-key",
      fetchImpl: fetchImpl as typeof fetch,
      sleepImpl: async () => {},
    });

    await expect(
      adapter.execute({
        runId: "run-1",
        taskId: "task-1",
        identifier: "TOK-1",
        repositoryId: "repo-1",
        repositorySlug: "crs-src",
        repositoryGitUrl: "git@github.com:michaelx1993/crs-src.git",
        role: "development",
        leaseOwner: "worker-test",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      retryable: false,
      reason: "OpenHands Cloud conversation conv-1 is waiting for human confirmation.",
      conversation: {
        provider: "openhands-cloud",
        conversationId: "conv-1",
        eventCursor: "waiting_for_confirmation",
      },
    });
  });

  it("maps terminal statuses into completion, retry, or block decisions", () => {
    expect(
      mapOpenHandsTerminalStatus({
        id: "conv-1",
        sandbox_status: "RUNNING",
        execution_status: "finished",
      }),
    ).toEqual({
      status: "succeeded",
      retryable: false,
      eventCursor: "finished",
    });

    expect(
      mapOpenHandsTerminalStatus({
        id: "conv-2",
        sandbox_status: "RUNNING",
        execution_status: "stuck",
      }),
    ).toEqual({
      status: "failed",
      retryable: false,
      eventCursor: "stuck",
      reason: "OpenHands Cloud conversation conv-2 is stuck and requires review.",
    });

    expect(
      mapOpenHandsTerminalStatus({
        id: "conv-3",
        sandbox_status: "ERROR",
        execution_status: "error",
      }),
    ).toEqual({
      status: "failed",
      retryable: true,
      eventCursor: "error",
      reason: "OpenHands Cloud sandbox ERROR for conversation conv-3.",
    });

    expect(
      mapOpenHandsTerminalStatus({
        id: "conv-4",
        sandbox_status: "RUNNING",
        execution_status: "COMPLETED",
      }),
    ).toEqual({
      status: "succeeded",
      retryable: false,
      eventCursor: "COMPLETED",
    });

    expect(
      mapOpenHandsTerminalStatus({
        id: "conv-5",
        sandbox_status: "RUNNING",
        execution_status: "FAILED",
      }),
    ).toEqual({
      status: "failed",
      retryable: true,
      eventCursor: "FAILED",
      reason: "OpenHands Cloud conversation conv-5 ended with sandbox=RUNNING execution=FAILED.",
    });

    expect(
      mapOpenHandsTerminalStatus({
        id: "conv-6",
        sandbox_status: "RUNNING",
        execution_status: "cancelled",
      }),
    ).toEqual({
      status: "failed",
      retryable: false,
      eventCursor: "cancelled",
      reason: "OpenHands Cloud conversation conv-6 ended with sandbox=RUNNING execution=cancelled.",
    });

    expect(
      mapOpenHandsTerminalStatus({
        id: "conv-7",
        sandbox_status: "RUNNING",
        execution_status: "requires-confirmation",
      }),
    ).toEqual({
      status: "failed",
      retryable: false,
      eventCursor: "requires-confirmation",
      reason: "OpenHands Cloud conversation conv-7 is waiting for human confirmation.",
    });
  });

  it("extracts OpenHands trace references from nested payloads", () => {
    expect(
      extractOpenHandsTraceRefs(
        {
          id: "conv-1",
          execution_status: "finished",
          trace_refs: {
            data: [
              {
                provider: "langfuse",
                trace_id: "trace-1",
                generation_id: "generation-1",
                model_name: "gpt-5.5",
                input_tokens: "12",
                outputTokens: 7,
                cost: 0.001,
                latency_ms: "250",
                trace_url: "https://langfuse.example.com/project/p/traces/trace-1",
              },
              {
                provider: "langfuse",
                model: "missing-trace-id",
              },
            ],
          },
        },
        "prompt-release-1",
      ),
    ).toEqual([
      {
        provider: "langfuse",
        traceId: "trace-1",
        generationId: "generation-1",
        promptReleaseId: "prompt-release-1",
        model: "gpt-5.5",
        inputTokens: 12,
        outputTokens: 7,
        costUsd: "0.001000",
        latencyMs: 250,
        uiUrl: "https://langfuse.example.com/project/p/traces/trace-1",
      },
    ]);
  });

  it("normalizes OpenHands list response shapes", () => {
    expect(parseOpenHandsList<{ id: string }>([{ id: "a" }])).toEqual([{ id: "a" }]);
    expect(parseOpenHandsList<{ id: string }>({ results: [{ id: "b" }] })).toEqual([{ id: "b" }]);
    expect(parseOpenHandsList<{ id: string }>({ data: [{ id: "c" }] })).toEqual([{ id: "c" }]);
    expect(parseOpenHandsList<{ id: string }>({ id: "d" })).toEqual([{ id: "d" }]);
    expect(parseOpenHandsList(null)).toEqual([]);
  });

  it("parses selected repository names from git urls", () => {
    expect(repositoryNameFromGitUrl("git@github.com:michaelx1993/crs-src.git")).toBe(
      "michaelx1993/crs-src",
    );
    expect(repositoryNameFromGitUrl("https://github.com/michaelx1993/traffic.git")).toBe(
      "michaelx1993/traffic",
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
