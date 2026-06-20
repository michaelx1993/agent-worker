import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { defaultNextStateForRole } from "../lifecycle.js";
import type {
  ExecutionAdapter,
  RunExecutionEvent,
  RunExecutionInput,
  RunExecutionResult,
} from "./types.js";
import { parseCodexJsonLines } from "./codex-cli.js";

interface CodexAppServerAdapterOptions {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  persistent?: boolean;
  spawnImpl?: typeof spawn;
}

interface RpcMessage {
  raw: string;
  payload?: Record<string, unknown>;
  parseError?: string;
}

interface RpcResult {
  terminal:
    | "completed"
    | "failed"
    | "cancelled"
    | "input_required"
    | "timeout"
    | "spawn_error"
    | "exit";
  threadId?: string;
  turnId?: string;
  stdoutLines: string[];
  stderr: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  reason?: string;
  reusedThread?: boolean;
}

const APP_SERVER_EVENT_LIMIT = 100;
const STDERR_CAPTURE_LIMIT = 4000;
const SIGKILL_GRACE_MS = 5_000;
const INITIALIZE_ID = 1;
const THREAD_START_ID = 2;
const TURN_START_ID = 3;

export class CodexAppServerAdapter implements ExecutionAdapter {
  private readonly command: string;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private readonly persistent: boolean;
  private readonly spawnImpl: typeof spawn;
  private session: CodexAppServerSession | undefined;

  constructor(options: CodexAppServerAdapterOptions = {}) {
    this.command = options.command ?? process.env.WORKER_CODEX_APP_SERVER_COMMAND ?? "codex";
    this.args = options.args ?? readCodexAppServerArgs();
    this.timeoutMs = options.timeoutMs ?? readPositiveIntEnv("WORKER_CODEX_TIMEOUT_MS", 3_600_000);
    this.persistent = options.persistent ?? false;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async execute(input: RunExecutionInput): Promise<RunExecutionResult> {
    const startedAt = Date.now();
    const result = this.persistent
      ? await this.runPersistentTurn(input)
      : await runAppServerSession({
          command: this.command,
          args: this.args,
          input,
          timeoutMs: this.timeoutMs,
          spawnImpl: this.spawnImpl,
        });
    const events = buildAppServerEvents(input, result, Date.now() - startedAt, this.timeoutMs);
    const conversation = {
      provider: "codex-app-server",
      conversationId:
        result.threadId && result.turnId
          ? `${result.threadId}/turns/${result.turnId}`
          : `codex-app-server-${input.runId}`,
      eventLogUri:
        result.threadId && result.turnId
          ? `process://codex-app-server/threads/${encodeURIComponent(
              result.threadId,
            )}/turns/${encodeURIComponent(result.turnId)}`
          : `process://codex-app-server/runs/${input.runId}`,
      eventCursor: result.terminal,
    };

    if (result.terminal === "completed") {
      const executionResult: RunExecutionResult = {
        status: "succeeded",
        summary: lastHighSignalMessage(events) ?? "Codex app-server completed turn.",
        conversation,
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
      reason: result.reason ?? `Codex app-server ended with ${result.terminal}.`,
      retryable: result.terminal !== "input_required" && result.terminal !== "cancelled",
      conversation,
      events,
    };
  }

  async dispose(): Promise<void> {
    this.session?.close();
    this.session = undefined;
  }

  private async runPersistentTurn(input: RunExecutionInput): Promise<RpcResult> {
    const session = this.session ?? this.createSession();
    this.session = session;
    const result = await session.runTurn(input, this.timeoutMs);
    if (result.terminal !== "completed" || session.closed) {
      this.session = undefined;
    }
    return result;
  }

  private createSession(): CodexAppServerSession {
    return new CodexAppServerSession({
      command: this.command,
      args: this.args,
      spawnImpl: this.spawnImpl,
    });
  }
}

export function createCodexAppServerAdapter(): ExecutionAdapter {
  return new CodexAppServerAdapter({
    persistent: readBooleanEnv("WORKER_CODEX_APP_SERVER_PERSISTENT", true),
  });
}

async function runAppServerSession(input: {
  command: string;
  args: string[];
  input: RunExecutionInput;
  timeoutMs: number;
  spawnImpl: typeof spawn;
}): Promise<RpcResult> {
  const session = new CodexAppServerSession({
    command: input.command,
    args: input.args,
    spawnImpl: input.spawnImpl,
  });

  try {
    return await session.runTurn(input.input, input.timeoutMs);
  } finally {
    session.close();
  }
}

class CodexAppServerSession {
  private child: ChildProcessWithoutNullStreams | undefined;
  private client: JsonLineClient | undefined;
  private initialized = false;

  constructor(
    private readonly input: {
      command: string;
      args: string[];
      spawnImpl: typeof spawn;
    },
  ) {}

  get closed(): boolean {
    return !this.child || Boolean(this.client?.closed);
  }

  async runTurn(input: RunExecutionInput, timeoutMs: number): Promise<RpcResult> {
    await this.ensureInitialized(input.workspacePath);
    const client = this.client;
    if (!client) {
      throw new Error("Codex app-server session was not initialized");
    }

    const messageOffset = client.rawMessages.length;
    let timeout: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<RpcResult>((resolve) => {
      timeout = setTimeout(() => {
        this.child?.kill("SIGTERM");
        killTimer = setTimeout(() => this.child?.kill("SIGKILL"), SIGKILL_GRACE_MS);
        resolve({
          terminal: "timeout",
          stdoutLines: client.rawMessages.slice(messageOffset),
          stderr: client.stderrText(),
          reason: `Codex app-server timed out after ${timeoutMs}ms.`,
        });
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        this.runTurnUntilTerminal(client, input, messageOffset),
        timeoutPromise,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
    }
  }

  close(): void {
    this.client?.close();
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.child = undefined;
    this.client = undefined;
    this.initialized = false;
  }

  private async ensureInitialized(workspacePath: string | undefined): Promise<void> {
    if (!this.child || this.client?.closed) {
      this.child = this.input.spawnImpl(this.input.command, this.input.args, {
        cwd: workspacePath,
        env: process.env,
        stdio: "pipe",
      }) as ChildProcessWithoutNullStreams;
      this.client = new JsonLineClient(this.child);
      this.initialized = false;
    }

    const client = this.client;
    if (!client) {
      throw new Error("Codex app-server client was not created");
    }
    if (this.initialized) {
      return;
    }

    await client.waitUntilReady();
    await client.sendRequest(INITIALIZE_ID, {
      method: "initialize",
      id: INITIALIZE_ID,
      params: {
        capabilities: { experimentalApi: true },
        clientInfo: {
          name: "agent-control-plane-worker",
          title: "Agent Control Plane Worker",
          version: "0.1.0",
        },
      },
    });
    client.sendNotification({ method: "initialized", params: {} });
    this.initialized = true;
  }

  private async runTurnUntilTerminal(
    client: JsonLineClient,
    input: RunExecutionInput,
    messageOffset: number,
  ): Promise<RpcResult> {
    try {
      const previousThreadId = extractPreviousCodexThreadId(input);
      let reusedThread = Boolean(previousThreadId);
      let threadId = previousThreadId;
      if (!threadId) {
        const threadResponse = await client.sendRequest(THREAD_START_ID, {
          method: "thread/start",
          id: THREAD_START_ID,
          params: {
            approvalPolicy: readApprovalPolicy(),
            sandbox: readThreadSandbox(),
            cwd: input.workspacePath,
            dynamicTools: [],
          },
        });
        threadId = extractId(threadResponse, ["result", "thread", "id"], ["thread", "id"]);
        reusedThread = false;
      }
      if (!threadId) {
        return failResult(
          client,
          "failed",
          "Codex app-server returned no thread id.",
          undefined,
          undefined,
          messageOffset,
        );
      }

      const turnResponse = await client.sendRequest(TURN_START_ID, {
        method: "turn/start",
        id: TURN_START_ID,
        params: {
          threadId,
          input: [{ type: "text", text: buildAppServerPrompt(input) }],
          cwd: input.workspacePath,
          title: `${input.identifier}: ${input.role}`,
          approvalPolicy: readApprovalPolicy(),
          sandboxPolicy: readTurnSandboxPolicy(input.workspacePath),
        },
      });
      const turnId = extractId(turnResponse, ["result", "turn", "id"], ["turn", "id"]);
      if (!turnId) {
        return failResult(
          client,
          "failed",
          "Codex app-server returned no turn id.",
          threadId,
          undefined,
          messageOffset,
        );
      }

      while (true) {
        const message = await client.nextMessage();
        const method =
          typeof message.payload?.method === "string" ? message.payload.method : undefined;
        if (method === "turn/completed") {
          return {
            terminal: "completed",
            threadId,
            turnId,
            stdoutLines: client.rawMessages.slice(messageOffset),
            stderr: client.stderrText(),
            reusedThread,
          };
        }
        if (method === "turn/failed") {
          return failResult(
            client,
            "failed",
            turnFailureReason(message.payload),
            threadId,
            turnId,
            messageOffset,
          );
        }
        if (method === "turn/cancelled") {
          return failResult(
            client,
            "cancelled",
            "Codex app-server turn was cancelled.",
            threadId,
            turnId,
            messageOffset,
          );
        }
        if (method && inputRequiredMethod(method)) {
          return failResult(
            client,
            "input_required",
            "Codex app-server turn requires operator input.",
            threadId,
            turnId,
            messageOffset,
          );
        }
      }
    } catch (error) {
      return {
        terminal: client.spawnError ? "spawn_error" : "exit",
        stdoutLines: client.rawMessages.slice(messageOffset),
        stderr: client.stderrText(),
        ...(client.exitCode !== undefined ? { exitCode: client.exitCode } : {}),
        ...(client.exitSignal !== undefined ? { exitSignal: client.exitSignal } : {}),
        reason:
          error instanceof Error
            ? error.message
            : client.spawnError
              ? `Codex app-server failed to start: ${client.spawnError}`
              : String(error),
      };
    }
  }
}

class JsonLineClient {
  readonly rawMessages: string[] = [];
  spawnError?: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  private readonly readline: ReadlineInterface;
  private readonly pendingMessages: RpcMessage[] = [];
  private readonly waiters: Array<(message: RpcMessage) => void> = [];
  private readonly stderr: Buffer[] = [];
  private readyResolver: (() => void) | undefined;
  private closeResolver: (() => void) | undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.readline = createInterface({ input: child.stdout });
    this.readline.on("line", (line) => this.acceptLine(line));
    child.stderr.on("data", (chunk) => this.stderr.push(Buffer.from(chunk)));
    child.on("spawn", () => this.readyResolver?.());
    child.on("error", (error) => {
      this.spawnError = error instanceof Error ? error.message : String(error);
      this.readyResolver?.();
      this.closeResolver?.();
    });
    child.on("close", (exitCode, exitSignal) => {
      this.exitCode = exitCode;
      this.exitSignal = exitSignal;
      this.closeResolver?.();
    });
  }

  get closed(): boolean {
    return this.exitCode !== undefined || Boolean(this.spawnError);
  }

  async waitUntilReady(): Promise<void> {
    if (this.spawnError || this.child.pid) {
      if (this.spawnError) throw new Error(`Codex app-server failed to start: ${this.spawnError}`);
      return;
    }
    await new Promise<void>((resolve) => {
      this.readyResolver = resolve;
    });
    if (this.spawnError) {
      throw new Error(`Codex app-server failed to start: ${this.spawnError}`);
    }
  }

  sendNotification(payload: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async sendRequest(
    id: number,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    while (true) {
      const message = await this.nextMessage();
      if (message.payload?.id === id) {
        return message.payload;
      }
    }
  }

  async nextMessage(): Promise<RpcMessage> {
    const message = this.pendingMessages.shift();
    if (message) {
      return message;
    }
    if (this.exitCode !== undefined || this.spawnError) {
      throw new Error(
        this.spawnError ?? `Codex app-server exited with code ${this.exitCode ?? "unknown"}.`,
      );
    }
    return new Promise<RpcMessage>((resolve) => {
      this.waiters.push(resolve);
      this.closeResolver = () => {
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter({
            raw: "",
            parseError:
              this.spawnError ?? `Codex app-server exited with code ${this.exitCode ?? "unknown"}.`,
          });
        }
      };
    }).then((next) => {
      if (next.parseError && !next.raw) {
        throw new Error(next.parseError);
      }
      return next;
    });
  }

  stderrText(): string {
    return Buffer.concat(this.stderr).toString("utf8");
  }

  close(): void {
    this.readline.close();
    this.child.stdin.destroy();
  }

  private acceptLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.rawMessages.push(trimmed);
    let message: RpcMessage;
    try {
      message = { raw: trimmed, payload: JSON.parse(trimmed) as Record<string, unknown> };
    } catch (error) {
      message = {
        raw: trimmed,
        parseError: error instanceof Error ? error.message : String(error),
      };
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      this.pendingMessages.push(message);
    }
  }
}

function buildAppServerEvents(
  input: RunExecutionInput,
  result: RpcResult,
  latencyMs: number,
  timeoutMs: number,
): RunExecutionEvent[] {
  const events: RunExecutionEvent[] = [
    {
      eventType: "codex.app_server_started",
      message: `Codex app-server started for ${input.identifier}.`,
      payload: {
        repository: input.repositorySlug,
        role: input.role,
        workspacePath: input.workspacePath ?? null,
      },
    },
  ];
  if (result.reusedThread && result.threadId) {
    events.push({
      eventType: "codex.thread_reused",
      message: `Codex app-server reused thread ${result.threadId} for ${input.identifier}.`,
      payload: {
        threadId: result.threadId,
        previousConversationId: input.previousConversation?.conversationId ?? null,
      },
    });
  }
  const parsed = parseCodexJsonLines(result.stdoutLines.join("\n"), APP_SERVER_EVENT_LIMIT);
  events.push(...parsed.events);
  if (parsed.totalLines > parsed.events.length) {
    events.push({
      eventType: "codex.events_truncated",
      message: `Codex app-server emitted ${parsed.totalLines} stdout events; only first ${parsed.events.length} were stored.`,
      payload: { totalEvents: parsed.totalLines, storedEvents: parsed.events.length },
    });
  }
  if (result.stderr.trim()) {
    events.push({
      eventType: "codex.stderr",
      message: firstNonEmptyLine(result.stderr) ?? "Codex app-server wrote stderr.",
      payload: { stderr: truncate(result.stderr, STDERR_CAPTURE_LIMIT) },
    });
  }
  if (result.terminal === "timeout") {
    events.push({
      eventType: "codex.timeout",
      message: `Codex app-server exceeded timeout of ${timeoutMs}ms for ${input.identifier}.`,
      payload: { timeoutMs },
    });
  }
  events.push({
    eventType: "codex.completed",
    message:
      result.terminal === "completed"
        ? `Codex app-server completed turn for ${input.identifier}.`
        : `Codex app-server ended with ${result.terminal} for ${input.identifier}.`,
    payload: {
      terminal: result.terminal,
      threadId: result.threadId ?? null,
      turnId: result.turnId ?? null,
      reusedThread: result.reusedThread ?? false,
      exitCode: result.exitCode ?? null,
      exitSignal: result.exitSignal ?? null,
      latencyMs,
    },
  });
  return events;
}

function readCodexAppServerArgs(): string[] {
  const jsonArgs = process.env.WORKER_CODEX_APP_SERVER_ARGS_JSON;
  if (jsonArgs) {
    const parsed = JSON.parse(jsonArgs) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("WORKER_CODEX_APP_SERVER_ARGS_JSON must be a JSON array of strings");
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
    "app-server",
  ];
}

function readApprovalPolicy(): string {
  return process.env.WORKER_CODEX_APPROVAL_POLICY?.trim() || "never";
}

function readThreadSandbox(): string {
  return process.env.WORKER_CODEX_THREAD_SANDBOX?.trim() || "workspace-write";
}

function readTurnSandboxPolicy(workspacePath: string | undefined): Record<string, unknown> {
  const raw = process.env.WORKER_CODEX_TURN_SANDBOX_POLICY_JSON;
  if (raw) {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("WORKER_CODEX_TURN_SANDBOX_POLICY_JSON must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  }
  return {
    type: "workspaceWrite",
    writableRoots: workspacePath ? [workspacePath] : [],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function buildAppServerPrompt(input: RunExecutionInput): string {
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

function extractPreviousCodexThreadId(input: RunExecutionInput): string | undefined {
  const previous = input.previousConversation;
  if (previous?.provider !== "codex-app-server") {
    return undefined;
  }

  return (
    parseThreadIdFromEventLogUri(previous.eventLogUri) ??
    parseThreadIdFromConversationId(previous.conversationId)
  );
}

function parseThreadIdFromEventLogUri(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const marker = "process://codex-app-server/threads/";
  if (!value.startsWith(marker)) {
    return undefined;
  }

  const [encodedThreadId] = value.slice(marker.length).split("/turns/");
  if (!encodedThreadId) {
    return undefined;
  }

  try {
    const decoded = decodeURIComponent(encodedThreadId);
    return decoded.trim() || undefined;
  } catch {
    return encodedThreadId.trim() || undefined;
  }
}

function parseThreadIdFromConversationId(value: string): string | undefined {
  const [threadId] = value.split("/turns/");
  const normalized = threadId?.trim();
  return value.includes("/turns/") && normalized ? normalized : undefined;
}

function extractId(payload: Record<string, unknown>, ...paths: string[][]): string | undefined {
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

function inputRequiredMethod(method: string): boolean {
  return [
    "turn/input_required",
    "turn/needs_input",
    "turn/need_input",
    "turn/request_input",
    "turn/request_response",
    "turn/provide_input",
    "turn/approval_required",
    "item/tool/requestUserInput",
  ].includes(method);
}

function failResult(
  client: JsonLineClient,
  terminal: RpcResult["terminal"],
  reason: string,
  threadId?: string,
  turnId?: string,
  messageOffset = 0,
): RpcResult {
  return {
    terminal,
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    stdoutLines: client.rawMessages.slice(messageOffset),
    stderr: client.stderrText(),
    reason,
  };
}

function turnFailureReason(payload: Record<string, unknown> | undefined): string {
  const params = payload?.params;
  if (params && typeof params === "object") {
    const record = params as Record<string, unknown>;
    for (const key of ["error", "message", "reason"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return "Codex app-server turn failed.";
}

function lastHighSignalMessage(events: RunExecutionEvent[]): string | undefined {
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.eventType.startsWith("codex.") &&
        ![
          "codex.app_server_started",
          "codex.started",
          "codex.completed",
          "codex.turn_completed",
        ].includes(event.eventType),
    )?.message;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value);
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
