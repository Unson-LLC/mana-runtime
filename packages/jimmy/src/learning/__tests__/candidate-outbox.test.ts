import { describe, expect, it, vi } from "vitest";
import { createStaticPersonResolver, LearningCandidateService, type LearningOutboxItem, type LearningOutboxRepository } from "../candidate-outbox.js";

describe("LearningCandidateService", () => {
  it("deduplicates evidence and retries candidate-store failures without writing Graph", async () => {
    const rows = new Map<string, LearningOutboxItem>();
    const repository: LearningOutboxRepository = {
      enqueue: vi.fn((item) => {
        const existing = rows.get(item.idempotencyKey);
        if (existing) return existing;
        rows.set(item.idempotencyKey, item);
        return item;
      }),
      claimPending: vi.fn(() => [...rows.values()].filter((row) => row.status === "pending").map((row) => {
        const claimed = { ...row, status: "submitting" as const, attemptCount: row.attemptCount + 1 };
        rows.set(row.idempotencyKey, claimed);
        return claimed;
      })),
      markSubmitted: vi.fn((key, candidateIds) => {
        const row = rows.get(key)!;
        rows.set(key, { ...row, status: "submitted", candidateIds });
        return true;
      }),
      markFailed: vi.fn((key, reasonCode, nextRetryAt, dead) => {
        const row = rows.get(key)!;
        rows.set(key, { ...row, status: dead ? "dead" : "pending", lastError: reasonCode, nextRetryAt });
        return true;
      }),
    };
    const submit = vi.fn()
      .mockResolvedValueOnce({ status: "unavailable", reasonCode: "http_503" })
      .mockResolvedValueOnce({ status: "submitted", candidateIds: ["cand-1"] });
    const service = new LearningCandidateService({
      repository,
      submit,
      resolveActorPersonId: createStaticPersonResolver('{"T1:U1":"per-1"}'),
    });
    const turn = {
      sessionId: "S1", userMessageId: "U1", assistantMessageId: "A1",
      userContent: "今後は請求を毎月確認する", assistantContent: "了解しました",
      workspace: "T1", channelId: "C1", actorExternalId: "U1", projectCode: "unson",
    };

    service.capture(turn);
    service.capture(turn);
    expect(rows.size).toBe(1);
    expect(JSON.stringify([...rows.values()][0].payload)).not.toContain('"userContent"');
    expect(JSON.stringify([...rows.values()][0].payload)).not.toContain('"assistantContent"');
    expect([...rows.values()][0].payload.actorPersonId).toBe("per-1");
    await service.flush();
    expect([...rows.values()][0]).toMatchObject({ status: "pending", lastError: "http_503", requiresReview: true });
    await service.flush();
    expect([...rows.values()][0]).toMatchObject({ status: "submitted", candidateIds: ["cand-1"] });
  });

  it("keeps identity-unresolved candidates repairable after the retry ceiling", async () => {
    const row: LearningOutboxItem = {
      idempotencyKey: "candidate-1",
      payload: {
        sessionId: "S1",
        userMessageId: "U1",
        assistantMessageId: "A1",
        workspace: "T1",
        channelId: "C1",
        actorExternalId: "U1",
        snippet: "User: remember this\nAssistant: understood",
        evidenceHash: "hash-1",
        extractorVersion: "conversation-turn-v1",
      },
      status: "submitting",
      requiresReview: true,
      attemptCount: 8,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    };
    const markFailed = vi.fn(() => true);
    const repository: LearningOutboxRepository = {
      enqueue: vi.fn((item) => item),
      claimPending: vi.fn(() => [row]),
      markSubmitted: vi.fn(() => true),
      markFailed,
    };
    const service = new LearningCandidateService({
      repository,
      submit: vi.fn().mockResolvedValue({ status: "unavailable", reasonCode: "identity_unresolved" }),
    });

    await service.flush();

    expect(markFailed).toHaveBeenCalledWith(
      "candidate-1",
      "identity_unresolved",
      expect.any(String),
      false,
    );
  });
});
