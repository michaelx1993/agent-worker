import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  extractOpenHandsTraceRefs,
  extractOpenHandsTraceRefsFromPayload,
  mapOpenHandsTerminalStatus,
  summarizeOpenHandsConversationEvents,
  summarizeOpenHandsEventLogPayload,
} from "./adapters/openhands-cloud.js";
import type { RunExecutionEvent, RunTraceRef } from "./adapters/types.js";

interface PayloadContract {
  conversation?: unknown;
  eventLog?: unknown;
  promptReleaseId?: string;
  expected?: {
    decisionStatus?: "succeeded" | "failed";
    retryable?: boolean;
    eventTypes?: string[];
    traceIds?: string[];
    redactedAbsent?: string[];
  };
}

const defaultFixtureFile = fileURLToPath(
  new URL("../fixtures/openhands-payload-contract.sample.json", import.meta.url),
);

function main() {
  const fixtureFile = process.env.OPENHANDS_PAYLOAD_CONTRACT_FILE || defaultFixtureFile;
  const contract = JSON.parse(fs.readFileSync(fixtureFile, "utf8")) as PayloadContract;
  if (!contract.conversation) {
    throw new Error("OpenHands payload contract requires a conversation object");
  }

  const decision = mapOpenHandsTerminalStatus(
    contract.conversation as Parameters<typeof mapOpenHandsTerminalStatus>[0],
  );
  const events = contract.eventLog
    ? summarizeOpenHandsEventLogPayload(contract.eventLog)
    : summarizeOpenHandsConversationEvents(
        contract.conversation as Parameters<typeof summarizeOpenHandsConversationEvents>[0],
      );
  const traceRefs = dedupeTraceRefs([
    ...extractOpenHandsTraceRefs(
      contract.conversation as Parameters<typeof extractOpenHandsTraceRefs>[0],
      contract.promptReleaseId,
    ),
    ...(contract.eventLog
      ? extractOpenHandsTraceRefsFromPayload(contract.eventLog, contract.promptReleaseId)
      : []),
  ]);

  assertContract(contract, decision, events, traceRefs);

  console.log("openhands_payload_contract=passed");
  console.log(`fixture_file=${fixtureFile}`);
  console.log(`decision_status=${decision.status}`);
  console.log(`retryable=${decision.retryable}`);
  console.log(`events=${events.length}`);
  console.log(`event_types=${[...new Set(events.map((event) => event.eventType))].join(",")}`);
  console.log(`trace_refs=${traceRefs.length}`);
  console.log(`trace_ids=${traceRefs.map((trace) => trace.traceId).join(",")}`);
}

function assertContract(
  contract: PayloadContract,
  decision: ReturnType<typeof mapOpenHandsTerminalStatus>,
  events: RunExecutionEvent[],
  traceRefs: RunTraceRef[],
) {
  if (events.length === 0) {
    throw new Error("OpenHands payload contract produced no event summaries");
  }

  const expected = contract.expected ?? {};
  if (expected.decisionStatus && decision.status !== expected.decisionStatus) {
    throw new Error(`expected decision ${expected.decisionStatus}, got ${decision.status}`);
  }

  if (expected.retryable !== undefined && decision.retryable !== expected.retryable) {
    throw new Error(`expected retryable=${expected.retryable}, got ${decision.retryable}`);
  }

  const eventTypes = new Set(events.map((event) => event.eventType));
  for (const eventType of expected.eventTypes ?? []) {
    if (!eventTypes.has(eventType)) {
      throw new Error(`missing OpenHands event summary type: ${eventType}`);
    }
  }

  const traceIds = new Set(traceRefs.map((trace) => trace.traceId));
  for (const traceId of expected.traceIds ?? []) {
    if (!traceIds.has(traceId)) {
      throw new Error(`missing OpenHands trace ref: ${traceId}`);
    }
  }

  const serialized = JSON.stringify({ events, traceRefs });
  for (const secretFragment of expected.redactedAbsent ?? []) {
    if (serialized.includes(secretFragment)) {
      throw new Error(`OpenHands payload contract leaked unredacted fragment: ${secretFragment}`);
    }
  }
}

function dedupeTraceRefs(traceRefs: RunTraceRef[]): RunTraceRef[] {
  const deduped = new Map<string, RunTraceRef>();
  for (const traceRef of traceRefs) {
    deduped.set(
      `${traceRef.provider}:${traceRef.traceId}:${traceRef.generationId ?? ""}`,
      traceRef,
    );
  }

  return [...deduped.values()];
}

try {
  main();
} catch (error) {
  console.error("openhands_payload_contract=failed");
  console.error(`error=${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
