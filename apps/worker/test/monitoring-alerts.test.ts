import { describe, expect, it } from "vitest";
import {
  MonitoringAlertNotifier,
  monitoringAlertFingerprint,
  type ControlPlaneSummary,
} from "../src/monitoring-alerts";

describe("MonitoringAlertNotifier", () => {
  it("stays disabled without a webhook URL", async () => {
    const notifier = new MonitoringAlertNotifier({
      minIntervalMs: 60_000,
      replayLimit: 10,
      retryBackoffMs: 300000,
      format: "generic",
    });

    await expect(notifier.notify(summaryWithAlerts())).resolves.toEqual({ status: "disabled" });
  });

  it("posts active alerts to the configured webhook", async () => {
    const requests: Array<{ url: string | URL; init?: RequestInit }> = [];
    const notifier = new MonitoringAlertNotifier(
      {
        webhookUrl: "https://hooks.example.com/acp",
        minIntervalMs: 60_000,
        replayLimit: 10,
        retryBackoffMs: 300000,
        format: "generic",
      },
      async (url, init) => {
        requests.push({ url, init });
        return new Response(null, { status: 204 });
      },
    );

    const result = await notifier.notify(summaryWithAlerts(), new Date("2026-06-19T12:00:00Z"));

    expect(result).toMatchObject({ status: "sent", statusCode: 204 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://hooks.example.com/acp");
    expect(requests[0]?.init?.method).toBe("POST");
    const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      source: "agent-control-plane",
      generatedAt: "2026-06-19T12:00:00.000Z",
      level: "critical",
      title: "Agent Control Plane critical alert",
    });
    expect(body.alerts).toEqual(summaryWithAlerts().alerts);
  });

  it("posts Slack Block Kit payloads when Slack format is configured", async () => {
    const requests: Array<{ url: string | URL; init?: RequestInit }> = [];
    const notifier = new MonitoringAlertNotifier(
      {
        webhookUrl: "https://hooks.example.com/acp",
        minIntervalMs: 60_000,
        replayLimit: 10,
        retryBackoffMs: 300000,
        format: "slack",
      },
      async (url, init) => {
        requests.push({ url, init });
        return new Response(null, { status: 204 });
      },
    );

    const result = await notifier.notify(summaryWithAlerts(), new Date("2026-06-19T12:00:00Z"));

    expect(result).toMatchObject({ status: "sent", statusCode: 204 });
    const body = JSON.parse(String(requests[0]?.init?.body)) as {
      text?: string;
      blocks?: Array<Record<string, unknown>>;
    };
    expect(body.text).toBe("Agent Control Plane critical alert: 1 active alert(s)");
    expect(body.blocks?.[0]).toMatchObject({
      type: "header",
      text: {
        type: "plain_text",
        text: "Agent Control Plane critical alert",
        emoji: false,
      },
    });
    expect(body.blocks?.[1]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: expect.stringContaining("Run 已停滞"),
      },
    });
  });

  it("posts email payloads when email format is configured", async () => {
    const requests: Array<{ url: string | URL; init?: RequestInit }> = [];
    const notifier = new MonitoringAlertNotifier(
      {
        webhookUrl: "https://hooks.example.com/email",
        minIntervalMs: 60_000,
        replayLimit: 10,
        retryBackoffMs: 300000,
        format: "email",
      },
      async (url, init) => {
        requests.push({ url, init });
        return new Response(null, { status: 202 });
      },
    );

    const result = await notifier.notify(summaryWithAlerts(), new Date("2026-06-19T12:00:00Z"));

    expect(result).toMatchObject({ status: "sent", statusCode: 202 });
    const body = JSON.parse(String(requests[0]?.init?.body)) as {
      subject?: string;
      text?: string;
      html?: string;
    };
    expect(body.subject).toBe("[Agent Control Plane] CRITICAL 1 active alert(s)");
    expect(body.text).toContain("Run 已停滞");
    expect(body.html).toContain("<h1>Agent Control Plane Alert</h1>");
  });

  it("throttles repeated alert fingerprints", async () => {
    let requestCount = 0;
    const notifier = new MonitoringAlertNotifier(
      {
        webhookUrl: "https://hooks.example.com/acp",
        minIntervalMs: 60_000,
        replayLimit: 10,
        retryBackoffMs: 300000,
        format: "generic",
      },
      async () => {
        requestCount += 1;
        return new Response(null, { status: 204 });
      },
    );
    const summary = summaryWithAlerts();
    const fingerprint = monitoringAlertFingerprint(summary.alerts);

    await expect(notifier.notify(summary, new Date("2026-06-19T12:00:00Z"))).resolves.toMatchObject(
      { status: "sent", fingerprint },
    );
    await expect(notifier.notify(summary, new Date("2026-06-19T12:00:30Z"))).resolves.toEqual({
      status: "throttled",
      fingerprint,
    });
    expect(requestCount).toBe(1);
  });
});

function summaryWithAlerts(): ControlPlaneSummary {
  return {
    teams: 1,
    projects: 1,
    repositories: 1,
    tasks: 4,
    activeTasks: 3,
    agentQueueLength: 22,
    humanGateTasks: 1,
    blockedTasks: 1,
    activeRuns: 2,
    stalledRuns: 1,
    retryBacklog: 2,
    failedRuns24h: 3,
    succeededRuns24h: 7,
    finishedRuns24h: 10,
    runSuccessRate24h: 0.7,
    tokenTotal: 1200,
    costUsd: 3.4,
    monitoringThresholds: {
      queueBacklogWarning: 20,
      stalledRunsCritical: 0,
      retryBacklogWarning: 0,
      failureRateCritical: 0.5,
      failureRateMinFinished: 3,
      costWarningUsd: 50,
      retryBackoffMs: 300000,
    },
    alertLevel: "critical",
    alerts: [
      {
        key: "stalled-runs",
        level: "critical",
        title: "Run 已停滞",
        detail: "1 个 run 已停滞，超过阈值 0，需要 operator 检查。",
      },
    ],
    runTrend24h: [],
    promptComponents: 3,
    promptBindings: 3,
  };
}
