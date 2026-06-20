import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexCliAdapter } from "./adapters/codex-cli.js";

async function main() {
  const tempDir = await mkdtemp(join(tmpdir(), "acp-codex-adapter-smoke-"));
  const fakeCodex = join(tempDir, "fake-codex.mjs");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
import fs from "node:fs";
let stdin = "";
process.stdin.on("data", (chunk) => stdin += chunk);
process.stdin.on("end", () => {
  const outputIndex = process.argv.indexOf("--output-last-message");
  if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], "Codex adapter smoke completed.");
  console.log(JSON.stringify({ type: "agent_message", message: "smoke accepted", stdinLength: stdin.length }));
  console.log(JSON.stringify({ type: "exec_command", message: "smoke command completed", exit_code: 0 }));
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
    const result = await adapter.execute({
      runId: `codex-adapter-smoke-${Date.now()}`,
      taskId: "codex-adapter-smoke-task",
      identifier: "ACP-CODEX-SMOKE",
      repositoryId: "codex-adapter-smoke-repo",
      repositorySlug: "aiworkspace",
      repositoryGitUrl: "git@github.com:michaelx1993/aiworkspace.git",
      workspacePath: tempDir,
      role: "development",
      leaseOwner: "codex-adapter-smoke",
      renderedPrompt: "这是 Agent Control Plane 的 Codex CLI adapter smoke。请输出简短确认。",
    });

    if (result.status !== "succeeded") {
      throw new Error(`Codex adapter smoke failed: ${result.reason}`);
    }
    if (result.nextState !== "Code Review") {
      throw new Error(`Expected next state Code Review, got ${result.nextState ?? "missing"}`);
    }
    if (result.conversation?.provider !== "codex-cli") {
      throw new Error("Codex adapter smoke did not return codex-cli conversation ref");
    }
    if (!result.events?.some((event) => event.eventType === "codex.agent_message")) {
      throw new Error("Codex adapter smoke did not capture codex.agent_message event");
    }

    console.log("codex_adapter_smoke=passed");
    console.log(`summary=${result.summary}`);
    console.log(`next_state=${result.nextState}`);
    console.log(`events=${result.events?.length ?? 0}`);
    console.log(`conversation_provider=${result.conversation.provider}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("codex_adapter_smoke=failed");
  console.error(`error=${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
