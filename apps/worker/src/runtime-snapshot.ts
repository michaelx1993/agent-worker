import type {
  WorkerClaimedRunContract,
  WorkerPreviousConversationContract,
} from "@agent-control-plane/core";

export interface ResolvedClaimedRunRuntime {
  repositoryId: string;
  repositorySlug: string;
  repositoryGitUrl: string;
  repositoryDefaultBranch: string;
  repositoryLocalPath?: string;
  promptReleaseId: string;
  renderedPrompt: string;
  previousConversation?: WorkerPreviousConversationContract;
}

type JsonRecord = Record<string, unknown>;

export function resolveClaimedRunRuntime(
  claimed: WorkerClaimedRunContract,
): ResolvedClaimedRunRuntime {
  const snapshot = planeRuntimeSnapshotPayload(claimed);
  const repository = objectValue(snapshot?.repository);
  const legacyPromptRelease = objectValue(snapshot?.legacyPromptRelease);
  const repositoryLocalPath = stringValue(repository?.localPath) ?? claimed.run.repositoryLocalPath;

  const previousConversation =
    previousConversationValue(snapshot?.previousConversation) ?? claimed.previousConversation;

  return {
    repositoryId: stringValue(repository?.id) ?? claimed.run.repositoryId,
    repositorySlug: stringValue(repository?.slug) ?? claimed.run.repositorySlug,
    repositoryGitUrl:
      stringValue(repository?.gitUrl) ??
      stringValue(repository?.url) ??
      claimed.run.repositoryGitUrl,
    repositoryDefaultBranch:
      stringValue(repository?.defaultBranch) ?? claimed.run.repositoryDefaultBranch,
    ...(repositoryLocalPath ? { repositoryLocalPath } : {}),
    promptReleaseId: stringValue(legacyPromptRelease?.id) ?? claimed.promptRelease.id,
    renderedPrompt: stringValue(snapshot?.assembledPrompt) ?? claimed.promptRelease.renderedContent,
    ...(previousConversation ? { previousConversation } : {}),
  };
}

export function planeRuntimeSnapshotPayload(
  claimed: WorkerClaimedRunContract,
): JsonRecord | undefined {
  const payload = claimed.planeRuntimeSnapshot?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const record = payload as JsonRecord;
  return record.schemaVersion === "plane-runtime-snapshot.v1" ? record : undefined;
}

function objectValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function previousConversationValue(value: unknown): WorkerPreviousConversationContract | undefined {
  const record = objectValue(value);
  const provider = stringValue(record?.provider);
  const conversationId = stringValue(record?.conversationId);
  if (!provider || !conversationId) {
    return undefined;
  }

  const conversation: WorkerPreviousConversationContract = {
    provider,
    conversationId,
  };

  const eventLogUri = stringValue(record?.eventLogUri);
  if (eventLogUri) {
    conversation.eventLogUri = eventLogUri;
  }

  const uiUrl = stringValue(record?.uiUrl);
  if (uiUrl) {
    conversation.uiUrl = uiUrl;
  }

  return conversation;
}
