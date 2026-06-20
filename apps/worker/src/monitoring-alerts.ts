import type { WorkerMonitoringAlertConfig } from "./config.js";

export interface MonitoringAlert {
  key: string;
  level: "ok" | "warning" | "critical";
  title: string;
  detail: string;
}

export interface ControlPlaneSummary {
  agentQueueLength: number;
  activeRuns: number;
  humanGateTasks: number;
  blockedTasks: number;
  stalledRuns: number;
  retryBacklog: number;
  failedRuns24h: number;
  succeededRuns24h: number;
  finishedRuns24h: number;
  runSuccessRate24h: number;
  tokenTotal: number;
  costUsd: number;
  monitoringThresholds: Record<string, unknown>;
  alertLevel: "ok" | "warning" | "critical";
  alerts: MonitoringAlert[];
}

export type MonitoringAlertNotificationResult =
  | { status: "disabled" }
  | { status: "no_alerts" }
  | { status: "throttled"; fingerprint: string }
  | { status: "sent"; fingerprint: string; statusCode: number; payload: unknown }
  | {
      status: "failed";
      fingerprint: string;
      reason: string;
      webhookUrl?: string;
      format?: string;
      payload?: unknown;
    };

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export class MonitoringAlertNotifier {
  private readonly config: WorkerMonitoringAlertConfig;
  private readonly fetchImpl: FetchLike;
  private lastFingerprint: string | undefined = undefined;
  private lastSentAt = 0;

  constructor(config: WorkerMonitoringAlertConfig, fetchImpl: FetchLike = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async notify(
    summary: ControlPlaneSummary,
    now: Date = new Date(),
  ): Promise<MonitoringAlertNotificationResult> {
    if (!this.config.webhookUrl) {
      return { status: "disabled" };
    }

    if (summary.alerts.length === 0 || summary.alertLevel === "ok") {
      this.lastFingerprint = undefined;
      this.lastSentAt = 0;
      return { status: "no_alerts" };
    }

    const fingerprint = monitoringAlertFingerprint(summary.alerts);
    const elapsedMs = now.getTime() - this.lastSentAt;
    if (fingerprint === this.lastFingerprint && elapsedMs < this.config.minIntervalMs) {
      return { status: "throttled", fingerprint };
    }

    const payload = buildMonitoringAlertPayload(summary, now, this.config.format);

    try {
      const response = await deliverMonitoringAlertPayload(
        this.fetchImpl,
        this.config.webhookUrl,
        payload,
      );
      if (!response.ok) {
        return {
          status: "failed",
          fingerprint,
          reason: `Webhook returned ${response.status}`,
          webhookUrl: this.config.webhookUrl,
          format: this.config.format,
          payload,
        };
      }

      this.lastFingerprint = fingerprint;
      this.lastSentAt = now.getTime();
      return { status: "sent", fingerprint, statusCode: response.status, payload };
    } catch (error) {
      return {
        status: "failed",
        fingerprint,
        reason: error instanceof Error ? error.message : String(error),
        webhookUrl: this.config.webhookUrl,
        format: this.config.format,
        payload,
      };
    }
  }
}

export function monitoringAlertFingerprint(alerts: readonly MonitoringAlert[]): string {
  return alerts
    .map((alert) => `${alert.level}:${alert.key}:${alert.detail}`)
    .sort()
    .join("|");
}

export function buildMonitoringAlertPayload(
  summary: ControlPlaneSummary,
  now: Date,
  format: WorkerMonitoringAlertConfig["format"],
) {
  if (format === "slack") {
    return slackMonitoringAlertPayload(summary, now);
  }

  if (format === "email") {
    return emailMonitoringAlertPayload(summary, now);
  }

  return {
    source: "agent-control-plane",
    generatedAt: now.toISOString(),
    level: summary.alertLevel,
    title: `Agent Control Plane ${summary.alertLevel} alert`,
    alerts: summary.alerts,
    metrics: {
      agentQueueLength: summary.agentQueueLength,
      activeRuns: summary.activeRuns,
      humanGateTasks: summary.humanGateTasks,
      blockedTasks: summary.blockedTasks,
      stalledRuns: summary.stalledRuns,
      retryBacklog: summary.retryBacklog,
      failedRuns24h: summary.failedRuns24h,
      succeededRuns24h: summary.succeededRuns24h,
      finishedRuns24h: summary.finishedRuns24h,
      runSuccessRate24h: summary.runSuccessRate24h,
      tokenTotal: summary.tokenTotal,
      costUsd: summary.costUsd,
    },
    thresholds: summary.monitoringThresholds,
  };
}

export async function deliverMonitoringAlertPayload(
  fetchImpl: FetchLike,
  webhookUrl: string,
  payload: unknown,
): Promise<Response> {
  return fetchImpl(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

function emailMonitoringAlertPayload(summary: ControlPlaneSummary, now: Date) {
  const subject = `[Agent Control Plane] ${summary.alertLevel.toUpperCase()} ${summary.alerts.length} active alert(s)`;
  const textLines = [
    subject,
    `Generated: ${now.toISOString()}`,
    "",
    ...summary.alerts.flatMap((alert) => [
      `${alert.level.toUpperCase()} ${alert.title}`,
      alert.detail,
      "",
    ]),
    "Metrics",
    `Queue: ${summary.agentQueueLength}`,
    `Active runs: ${summary.activeRuns}`,
    `Retry backlog: ${summary.retryBacklog}`,
    `Success 24h: ${formatPercent(summary.runSuccessRate24h)}`,
    `Cost: $${summary.costUsd.toFixed(2)}`,
  ];
  const alertItems = summary.alerts
    .map(
      (alert) =>
        `<li><strong>${escapeHtml(alert.level.toUpperCase())} ${escapeHtml(
          alert.title,
        )}</strong><br>${escapeHtml(alert.detail)}</li>`,
    )
    .join("");

  return {
    subject,
    text: textLines.join("\n"),
    html: [
      "<h1>Agent Control Plane Alert</h1>",
      `<p><strong>Level:</strong> ${escapeHtml(summary.alertLevel)}</p>`,
      `<p><strong>Generated:</strong> ${escapeHtml(now.toISOString())}</p>`,
      `<ul>${alertItems}</ul>`,
      "<h2>Metrics</h2>",
      "<ul>",
      `<li>Queue: ${summary.agentQueueLength}</li>`,
      `<li>Active runs: ${summary.activeRuns}</li>`,
      `<li>Retry backlog: ${summary.retryBacklog}</li>`,
      `<li>Success 24h: ${escapeHtml(formatPercent(summary.runSuccessRate24h))}</li>`,
      `<li>Cost: $${escapeHtml(summary.costUsd.toFixed(2))}</li>`,
      "</ul>",
    ].join(""),
  };
}

function slackMonitoringAlertPayload(summary: ControlPlaneSummary, now: Date) {
  const title = `Agent Control Plane ${summary.alertLevel} alert`;
  const alertLines = summary.alerts
    .slice(0, 8)
    .map((alert) => `*${alert.level.toUpperCase()}* ${alert.title}\n${alert.detail}`)
    .join("\n\n");

  return {
    text: `${title}: ${summary.alerts.length} active alert(s)`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: title,
          emoji: false,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: alertLines || "No active alerts.",
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Queue*\n${summary.agentQueueLength}`,
          },
          {
            type: "mrkdwn",
            text: `*Active runs*\n${summary.activeRuns}`,
          },
          {
            type: "mrkdwn",
            text: `*Retry backlog*\n${summary.retryBacklog}`,
          },
          {
            type: "mrkdwn",
            text: `*Success 24h*\n${formatPercent(summary.runSuccessRate24h)}`,
          },
          {
            type: "mrkdwn",
            text: `*Cost*\n$${summary.costUsd.toFixed(2)}`,
          },
          {
            type: "mrkdwn",
            text: `*Generated*\n${now.toISOString()}`,
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "source: agent-control-plane",
          },
        ],
      },
    ],
  };
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
