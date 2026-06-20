import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerAdapter } from "./adapters/codex-app-server.js";

async function main() {
  const tempDir = await mkdtemp(join(tmpdir(), "acp-codex-app-server-smoke-"));
  const fakeCodex = join(tempDir, "fake-codex-app-server.mjs");
  await writeFakeAppServer(fakeCodex);

  try {
    const adapter = new CodexAppServerAdapter({
      command: fakeCodex,
      args: ["app-server"],
      timeoutMs: 5_000,
    });
    const result = await adapter.execute({
      runId: `codex-app-server-smoke-${Date.now()}`,
      taskId: "codex-app-server-smoke-task",
      identifier: "ACP-CODEX-APP-SERVER-SMOKE",
      repositoryId: "codex-app-server-smoke-repo",
      repositorySlug: "aiworkspace",
      repositoryGitUrl: "git@github.com:michaelx1993/aiworkspace.git",
      workspacePath: tempDir,
      role: "development",
      leaseOwner: "codex-app-server-smoke",
      renderedPrompt:
        "这是 Agent Control Plane 的 Codex app-server adapter smoke。请输出简短确认。",
    });

    if (result.status !== "succeeded") {
      throw new Error(`Codex app-server smoke failed: ${result.reason}`);
    }
    if (result.conversation?.provider !== "codex-app-server") {
      throw new Error("Codex app-server smoke did not return codex-app-server conversation ref");
    }
    if (!result.events?.some((event) => event.eventType === "codex.agent_message")) {
      throw new Error("Codex app-server smoke did not capture agent message event");
    }
    if (!result.events?.some((event) => event.eventType === "codex.exec_command")) {
      throw new Error("Codex app-server smoke did not capture command output event");
    }

    console.log("codex_app_server_smoke=passed");
    console.log(`summary=${result.summary}`);
    console.log(`next_state=${result.nextState ?? "none"}`);
    console.log(`events=${result.events?.length ?? 0}`);
    console.log(`conversation_provider=${result.conversation.provider}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function writeFakeAppServer(file: string): Promise<void> {
  await writeFile(
    file,
    `#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}

rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ id: request.id, result: { serverInfo: { name: "fake-codex" } } });
  } else if (request.method === "thread/start") {
    send({ id: request.id, result: { thread: { id: "thread-smoke" } } });
  } else if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "turn-smoke" } } });
    send({ method: "codex/event/agent_message_delta", params: { msg: { payload: { delta: "app-server smoke accepted task context" } } } });
    send({ method: "item/commandExecution/outputDelta", params: { outputDelta: "smoke command completed" } });
    send({ method: "turn/completed", params: { turn: { status: "completed" } } });
    process.exit(0);
  }
});
`,
  );
  await chmod(file, 0o700);
}

main().catch((error: unknown) => {
  console.error("codex_app_server_smoke=failed");
  console.error(`error=${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
