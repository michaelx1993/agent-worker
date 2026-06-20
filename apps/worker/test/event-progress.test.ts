import { describe, expect, it } from "vitest";
import { summarizeExecutionEventsForProgress } from "../src/event-progress";

describe("execution event progress summaries", () => {
  it("summarizes high-signal Codex and OpenHands events for task progress", () => {
    expect(
      summarizeExecutionEventsForProgress([
        { eventType: "codex.started", message: "Codex started." },
        { eventType: "codex.agent_message", message: "Implemented the parser." },
        { eventType: "codex.exec_command", message: "pnpm test passed." },
        { eventType: "openhands.file_operation", message: "Edited app.ts." },
      ]),
    ).toBe(
      [
        "Agent Events: execution produced task-visible progress.",
        "- codex.agent_message: Implemented the parser.",
        "- codex.exec_command: pnpm test passed.",
        "- openhands.file_operation: Edited app.ts.",
      ].join("\n"),
    );
  });

  it("redacts common secret patterns and limits noisy summaries", () => {
    const summary = summarizeExecutionEventsForProgress(
      [
        { eventType: "codex.agent_message", message: "api_key=sk_abcdefghijklmnopqrstuvwxyz" },
        { eventType: "codex.exec_command", message: "Bearer abcdefghijklmnopqrstuvwxyz" },
        { eventType: "codex.stderr", message: "third event" },
      ],
      { limit: 2 },
    );

    expect(summary).toContain("api_key=[REDACTED]");
    expect(summary).toContain("Bearer [REDACTED]");
    expect(summary).toContain("1 more execution events");
    expect(summary).not.toContain("sk_abcdefghijklmnopqrstuvwxyz");
    expect(summary).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("does not create progress for low-signal lifecycle-only events", () => {
    expect(
      summarizeExecutionEventsForProgress([
        { eventType: "codex.started", message: "Codex started." },
        { eventType: "codex.completed", message: "Codex completed." },
        { eventType: "workspace.ready", message: "Workspace ready." },
      ]),
    ).toBeUndefined();
  });
});
