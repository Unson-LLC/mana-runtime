import { createHmac } from "node:crypto";
import type {
  LearningCandidateSubmitter,
  LearningOutboxItem,
} from "./candidate-outbox.js";

export interface BrainbaseCandidateStoreOptions {
  baseUrl?: string;
  hmacSecret?: string;
  source?: string;
  fetchImpl?: typeof fetch;
}

function candidateEnvelope(item: LearningOutboxItem, source: string) {
  const payload = item.payload;
  const capturedAt = new Date().toISOString();
  return {
    raw_event_id: item.idempotencyKey,
    source_system: source,
    source_event_id: item.idempotencyKey,
    occurred_at: item.createdAt,
    captured_at: capturedAt,
    actor_external_id: payload.actorExternalId,
    actor_person_id: payload.actorPersonId,
    workspace: payload.workspace,
    permission_snapshot: { roles: ["conversation_participant"], clearance: ["candidate_review"] },
    evidence_ref: {
      kind: "conversation_turn",
      uri: `mana://sessions/${payload.sessionId}/messages/${payload.userMessageId}`,
      hash: payload.evidenceHash.startsWith("sha256:")
        ? payload.evidenceHash
        : `sha256:${payload.evidenceHash}`,
    },
    retention_policy: "envelope_only",
    snippet: payload.snippet,
    channel_id: payload.channelId,
    project_code: payload.projectCode,
    requires_review: true,
    extractor_version: payload.extractorVersion,
  };
}

export function createBrainbaseCandidateSubmitter(
  options: BrainbaseCandidateStoreOptions,
): LearningCandidateSubmitter {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (item) => {
    if (!options.baseUrl || !options.hmacSecret) {
      return { status: "unavailable", reasonCode: "not_configured" };
    }
    if (!item.payload.actorPersonId?.trim()) {
      return { status: "unavailable", reasonCode: "identity_unresolved" };
    }
    const source = options.source?.trim() || "mana_slack";
    const body = JSON.stringify(candidateEnvelope(item, source));
    const signature = createHmac("sha256", options.hmacSecret).update(body).digest("hex");
    try {
      const response = await fetchImpl(
        `${options.baseUrl.replace(/\/$/, "")}/api/candidate-store/raw-ledger`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-cs-source": source,
            "x-cs-signature": signature,
          },
          body,
        },
      );
      if (!response.ok) return { status: "unavailable", reasonCode: `http_${response.status}` };
      const result = await response.json() as { candidate_ids?: string[]; candidateIds?: string[]; id?: string };
      const candidateIds = result.candidate_ids ?? result.candidateIds ?? (result.id ? [result.id] : []);
      return { status: "submitted", candidateIds };
    } catch {
      return { status: "unavailable", reasonCode: "network_error" };
    }
  };
}
