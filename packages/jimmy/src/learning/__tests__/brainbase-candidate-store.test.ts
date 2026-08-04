import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LearningOutboxItem } from "../candidate-outbox.js";
import { createBrainbaseCandidateSubmitter } from "../brainbase-candidate-store.js";

function outboxItem(): LearningOutboxItem {
  return {
    idempotencyKey: "idem-1",
    payload: {
      sessionId: "session-1",
      userMessageId: "user-message-1",
      assistantMessageId: "assistant-message-1",
      workspace: "T1",
      channelId: "C1",
      actorExternalId: "U1",
      actorPersonId: "per-1",
      projectCode: "brainbase",
      snippet: "User: question\nAssistant: answer",
      evidenceHash: "hash-1",
      extractorVersion: "conversation-turn-v1",
    },
    status: "pending",
    requiresReview: true,
    attemptCount: 0,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  };
}

describe("Brainbase candidate submitter", () => {
  it("signs the exact review-required raw-ledger envelope", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ candidate_ids: ["candidate-1"] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const submit = createBrainbaseCandidateSubmitter({
      baseUrl: "https://brainbase.example/",
      hmacSecret: "test-secret",
      source: "mana_slack",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(submit(outboxItem())).resolves.toEqual({
      status: "submitted",
      candidateIds: ["candidate-1"],
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = String(init.body);
    const envelope = JSON.parse(body) as Record<string, unknown>;
    const headers = init.headers as Record<string, string>;

    expect(url).toBe("https://brainbase.example/api/candidate-store/raw-ledger");
    expect(init.method).toBe("POST");
    expect(headers["x-cs-source"]).toBe("mana_slack");
    expect(headers["x-cs-signature"]).toBe(
      createHmac("sha256", "test-secret").update(body).digest("hex"),
    );
    expect(envelope).toMatchObject({
      raw_event_id: "idem-1",
      source_system: "mana_slack",
      source_event_id: "idem-1",
      actor_external_id: "U1",
      actor_person_id: "per-1",
      workspace: "T1",
      channel_id: "C1",
      requires_review: true,
      retention_policy: "envelope_only",
    });
    expect(body).not.toContain("test-secret");
  });

  it("fails closed while the Slack identity is not mapped to a canonical person", async () => {
    const fetchImpl = vi.fn();
    const item = outboxItem();
    delete item.payload.actorPersonId;
    const submit = createBrainbaseCandidateSubmitter({
      baseUrl: "https://brainbase.example",
      hmacSecret: "test-secret",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(submit(item)).resolves.toEqual({
      status: "unavailable",
      reasonCode: "identity_unresolved",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports unavailable without making a request when credentials are absent", async () => {
    const fetchImpl = vi.fn();
    const submit = createBrainbaseCandidateSubmitter({ fetchImpl: fetchImpl as typeof fetch });

    await expect(submit(outboxItem())).resolves.toEqual({
      status: "unavailable",
      reasonCode: "not_configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
