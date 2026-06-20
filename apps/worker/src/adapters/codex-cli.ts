import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultNextStateForRole } from "../lifecycle.js";
import type {
  ExecutionAdapter,
  RunExecutionEvent,
  RunExecutionInput,
  RunExecutionResult,
} from "./types.js";

interface CodexCliAdapterOptions {
  command?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}

interface ProcessResult {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

const CODEX_OUTPUT_EVENT_LIMIT = 25;
const STDERR_CAPTURE_LIMIT = 4000;
const SIGKILL_GRACE_MS = 5_000;

export class CodexCliAdapter implements ExecutionAdapter {
  private readonly command: string;
  private readonly extraArgs: string[];
  private readonly timeoutMs: number;
  private readonly spawnImpl: typeof spawn;

  constructor(options: CodexCliAdapterOptions = {}) {
    this.command = options.command ?? process.env.WORKER_CODEX_COMMAND ?? "codex";
    this.extraArgs = options.extraArgs ?? readCodexExtraArgs();
    this.timeoutMs = options.timeoutMs ?? readPositiveIntEnv("WORKER_CODEX_TIMEOUT_MS", 3_600_000);
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async execute(input: RunExecutionInput): Promise<RunExecutionResult> {
    const startedAt = Date.now();
    const tempDir = await mkdtemp(join(tmpdir(), "acp-codex-cli-"));
    const outputFile = join(tempDir, "last-message.txt");
    const args = buildCodexExecArgs(input, outputFile, this.extraArgs);

    try {
      const processInput = {
        command: this.command,
        args,
        stdin: buildCodexPrompt(input),
        timeoutMs: this.timeoutMs,
        spawnImpl: this.spawnImpl,
        ...(input.workspacePath ? { cwd: input.workspacePath } : {}),
      };
      const result = await runProcess(processInput);
      const lastMessage = await readOptionalText(outputFile);
      const events = buildCodexEvents(input, result, Date.now() - startedAt, this.timeoutMs);

      if (result.exitCode === 0 && !result.timedOut && !result.spawnError) {
        const executionResult: RunExecutionResult = {
          status: "succeeded",
          summary: firstNonEmptyLine(lastMessage) ?? "Codex CLI completed run.",
          conversation: {
            provider: "codex-cli",
            conversationId: `codex-${input.runId}`,
            eventLogUri: `process://codex-cli/runs/${input.runId}`,
            eventCursor: `exit:${result.exitCode}`,
          },
          events,
        };
        const nextState = defaultNextStateForRole(input.role);
        if (nextState) {
          executionResult.nextState = nextState;
        }
        return executionResult;
      }

      return {
        status: "failed",
        reason: buildFailureReason(result, lastMessage, this.timeoutMs),
        retryable: true,
        conversation: {
          provider: "codex-cli",
          conversationId: `codex-${input.runId}`,
          eventLogUri: `process://codex-cli/runs/${input.runId}`,
          eventCursor: result.spawnError
            ? "spawn-error"
            : result.timedOut
              ? "timeout"
              : `exit:${result.exitCode}`,
        },
        events,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export function createCodexCliAdapter(): ExecutionAdapter {
  return new CodexCliAdapter();
}

function buildCodexExecArgs(input: RunExecutionInput, outputFile: string, extraArgs: string[]) {
  const args = ["exec", "--json", "--output-last-message", outputFile];
  if (input.workspacePath) {
    args.push("-C", input.workspacePath);
  }
  args.push(...extraArgs, "-");
  return args;
}

function buildCodexPrompt(input: RunExecutionInput): string {
  const prompt = input.renderedPrompt?.trim() || `Execute task ${input.identifier}.`;
  return [
    prompt,
    "",
    "# Agent Control Plane Context",
    `- Task: ${input.identifier}`,
    `- Role: ${input.role}`,
    `- Repository: ${input.repositorySlug}`,
    input.workspacePath ? `- Workspace: ${input.workspacePath}` : undefined,
    input.workspaceHeadRef ? `- Head ref: ${input.workspaceHeadRef}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function readCodexExtraArgs(): string[] {
  const jsonArgs = process.env.WORKER_CODEX_ARGS_JSON;
  if (jsonArgs) {
    const parsed = JSON.parse(jsonArgs) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("WORKER_CODEX_ARGS_JSON must be a JSON array of strings");
    }
    return parsed;
  }

  const model = process.env.WORKER_CODEX_MODEL ?? process.env.CODEX_MODEL ?? "gpt-5.5";
  const reasoningEffort = process.env.WORKER_CODEX_REASONING_EFFORT ?? "high";
  return [
    "--dangerously-bypass-approvals-and-sandbox",
    "--config",
    "shell_environment_policy.inherit=all",
    "--config",
    `model_reasoning_effort=${reasoningEffort}`,
    "-m",
    model,
  ];
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function runProcess(input: {
  command: string;
  args: string[];
  cwd?: string;
  stdin: string;
  timeoutMs: number;
  spawnImpl: typeof spawn;
}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = input.spawnImpl(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: "pipe",
    }) as ChildProcessWithoutNullStreams;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, SIGKILL_GRACE_MS);
    }, input.timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.stdin.on("error", () => {
      // The child may exit before stdin is fully written; close/error is handled below.
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode: null,
        exitSignal: null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        spawnError: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode,
        exitSignal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      });
    });

    child.stdin.end(input.stdin);
  });
}

function buildCodexEvents(
  input: RunExecutionInput,
  result: ProcessResult,
  latencyMs: number,
  timeoutMs: number,
): RunExecutionEvent[] {
  const events: RunExecutionEvent[] = [
    {
      eventType: "codex.started",
      message: `Codex CLI started for ${input.identifier}.`,
      payload: {
        repository: input.repositorySlug,
        role: input.role,
        workspacePath: input.workspacePath ?? null,
      },
    },
  ];
  if (result.spawnError) {
    events.push({
      eventType: "codex.spawn_error",
      message: `Codex CLI failed to start: ${result.spawnError}`,
      payload: { error: result.spawnError },
    });
  }
  const parsed = parseCodexJsonLines(result.stdout, CODEX_OUTPUT_EVENT_LIMIT);
  for (const event of parsed.events) {
    events.push(event);
  }
  if (parsed.totalLines > parsed.events.length) {
    events.push({
      eventType: "codex.events_truncated",
      message: `Codex CLI emitted ${parsed.totalLines} stdout events; only first ${parsed.events.length} were stored.`,
      payload: { totalEvents: parsed.totalLines, storedEvents: parsed.events.length },
    });
  }
  if (result.stderr.trim()) {
    const redactedStderr = redactSensitiveText(result.stderr);
    events.push({
      eventType: "codex.stderr",
      message: firstNonEmptyLine(redactedStderr) ?? "Codex CLI wrote stderr.",
      payload: { stderr: truncate(redactedStderr, STDERR_CAPTURE_LIMIT) },
    });
  }
  if (result.timedOut) {
    events.push({
      eventType: "codex.timeout",
      message: `Codex CLI exceeded timeout of ${timeoutMs}ms for ${input.identifier}.`,
      payload: { timeoutMs },
    });
  }
  events.push({
    eventType: "codex.completed",
    message: buildCompletionMessage(input, result),
    payload: {
      exitCode: result.exitCode,
      exitSignal: result.exitSignal,
      timedOut: result.timedOut,
      latencyMs,
    },
  });
  return events;
}

function buildCompletionMessage(input: RunExecutionInput, result: ProcessResult): string {
  if (result.timedOut) {
    return `Codex CLI timed out for ${input.identifier}.`;
  }
  if (result.spawnError) {
    return `Codex CLI failed to start for ${input.identifier}.`;
  }
  if (result.exitCode === 0) {
    return `Codex CLI exited successfully for ${input.identifier}.`;
  }
  return `Codex CLI exited with code ${result.exitCode ?? "unknown"} for ${input.identifier}.`;
}

export function parseCodexJsonLines(
  stdout: string,
  limit: number,
): { events: RunExecutionEvent[]; totalLines: number } {
  const events: RunExecutionEvent[] = [];
  let totalLines = 0;
  for (const line of stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    totalLines += 1;
    if (events.length >= limit) {
      continue;
    }
    try {
      const parsed = redactSensitivePayload(JSON.parse(line)) as {
        event?: unknown;
        method?: unknown;
        type?: unknown;
        msg?: unknown;
        message?: unknown;
      };
      const rawType =
        typeof parsed.type === "string"
          ? parsed.type
          : typeof parsed.method === "string"
            ? parsed.method
            : typeof parsed.event === "string"
              ? parsed.event
              : "event";
      const type = normalizeCodexEventType(rawType);
      const message = extractCodexEventMessage(rawType, parsed);
      events.push({
        eventType: `codex.${type}`,
        message,
        payload: parsed,
      });
    } catch {
      const redactedLine = redactSensitiveText(line);
      events.push({
        eventType: "codex.output",
        message: truncate(redactedLine, 200),
        payload: { line: truncate(redactedLine, 4000) },
      });
    }
  }
  return { events, totalLines };
}

async function readOptionalText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function normalizeCodexEventType(rawType: string): string {
  const normalized = rawType.trim();
  if (
    normalized === "agent_message" ||
    normalized === "agent_message_delta" ||
    normalized === "agent_message_content_delta" ||
    normalized === "item/agentMessage/delta" ||
    normalized === "codex/event/agent_message_delta" ||
    normalized === "codex/event/agent_message_content_delta"
  ) {
    return "agent_message";
  }
  if (
    normalized === "agent_reasoning" ||
    normalized === "agent_reasoning_delta" ||
    normalized === "reasoning_content_delta" ||
    normalized.startsWith("item/reasoning/") ||
    normalized.startsWith("codex/event/agent_reasoning") ||
    normalized === "codex/event/reasoning_content_delta"
  ) {
    return "reasoning";
  }
  if (
    normalized === "exec_command_begin" ||
    normalized === "exec_command_end" ||
    normalized === "exec_command_output_delta" ||
    normalized.startsWith("item/commandExecution/") ||
    normalized.startsWith("codex/event/exec_command")
  ) {
    return "exec_command";
  }
  if (
    normalized === "turn_diff" ||
    normalized === "item/fileChange/outputDelta" ||
    normalized.startsWith("codex/event/file")
  ) {
    return "file_operation";
  }
  if (normalized === "item/plan/delta" || normalized === "turn/plan/updated") {
    return "plan";
  }
  if (normalized === "thread/tokenUsage/updated" || normalized === "token_count") {
    return "token_usage";
  }
  return normalized
    .replace(/^codex\/event\//, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
    .toLowerCase();
}

function extractCodexEventMessage(rawType: string, payload: unknown): string {
  const directMessage = extractFirstStringPath(payload, [["msg"], ["message"]]);
  if (directMessage) {
    return directMessage;
  }

  const preview = extractFirstStringPath(payload, codexPreviewPaths());
  if (preview) {
    return `${codexEventLabel(rawType)}: ${inlineEventText(preview)}`;
  }
  return `Codex event: ${rawType}`;
}

function codexEventLabel(rawType: string): string {
  const type = normalizeCodexEventType(rawType);
  if (type === "agent_message") return "agent message streaming";
  if (type === "reasoning") return "reasoning streaming";
  if (type === "exec_command") return "command output streaming";
  if (type === "file_operation") return "file change output streaming";
  if (type === "plan") return "plan streaming";
  if (type === "token_usage") return "token usage updated";
  return `Codex event ${rawType}`;
}

function codexPreviewPaths(): string[][] {
  return [
    ["params", "delta"],
    ["params", "msg", "delta"],
    ["params", "textDelta"],
    ["params", "msg", "textDelta"],
    ["params", "outputDelta"],
    ["params", "msg", "outputDelta"],
    ["params", "text"],
    ["params", "msg", "text"],
    ["params", "summaryText"],
    ["params", "msg", "summaryText"],
    ["params", "msg", "content"],
    ["params", "msg", "payload", "delta"],
    ["params", "msg", "payload", "textDelta"],
    ["params", "msg", "payload", "outputDelta"],
    ["params", "msg", "payload", "text"],
    ["params", "msg", "payload", "summaryText"],
    ["params", "msg", "payload", "content"],
  ];
}

function extractFirstStringPath(payload: unknown, paths: string[][]): string | undefined {
  for (const path of paths) {
    let current: unknown = payload;
    for (const key of path) {
      if (!current || typeof current !== "object" || !(key in current)) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }
    if (typeof current === "string" && current.trim()) {
      return current.trim();
    }
  }
  return undefined;
}

function inlineEventText(value: string): string {
  return truncate(value.replace(/\s+/g, " ").trim(), 200);
}

function buildFailureReason(result: ProcessResult, lastMessage: string, timeoutMs: number): string {
  if (result.spawnError) {
    return `Codex CLI failed to start: ${result.spawnError}`;
  }
  if (result.timedOut) {
    return `Codex CLI timed out after ${timeoutMs}ms.`;
  }
  return (
    firstNonEmptyLine(redactSensitiveText(result.stderr)) ??
    firstNonEmptyLine(lastMessage) ??
    `Codex CLI exited with code ${result.exitCode}.`
  );
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(?:sk|pk)_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{12,}\b/g, "[REDACTED_TOKEN]")
    .replace(
      /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key)[A-Za-z0-9_.-]*\s*[=:]\s*)\S+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]");
}

function redactSensitivePayload(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitivePayload(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSensitivePayload(item)]),
    );
  }
  return value;
}
