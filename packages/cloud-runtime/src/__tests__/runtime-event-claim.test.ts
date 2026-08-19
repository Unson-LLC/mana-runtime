import {
  claimRuntimeEvent,
  completeRuntimeEvent,
  releaseRuntimeEvent,
  runtimeClaimSettlement,
  runtimeDeliveryId,
} from "../runtime-event-claim.js";

function storage() {
  const values = new Map<string, unknown>();
  const transaction = async <T>(fn: (tx: {
    get<V>(key: string): Promise<V | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  }) => Promise<T>) => fn({
    get: async <V>(key: string) => values.get(key) as V | undefined,
    put: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); },
  });
  return { transaction, values };
}

describe("runtime event claim", () => {
  it("allows only one concurrent delivery to own an event", async () => {
    const db = storage();
    const owner = await claimRuntimeEvent(db, "Ev_same", 1_000);
    expect(owner).toMatchObject({ disposition: "claimed" });
    expect(await claimRuntimeEvent(db, "Ev_same", 1_001)).toMatchObject({ disposition: "in_progress" });
    if (owner.disposition !== "claimed") throw new Error("expected_claim_owner");
    await completeRuntimeEvent(db, "Ev_same", owner.claimToken, "1700.1", 1_100);
    expect(await claimRuntimeEvent(db, "Ev_same", 9_999_999))
      .toEqual({ disposition: "completed", responseTs: "1700.1" });
  });

  it("releases a failed event so a queue retry can process it", async () => {
    const db = storage();
    const owner = await claimRuntimeEvent(db, "Ev_retry", 1_000);
    if (owner.disposition !== "claimed") throw new Error("expected_claim_owner");
    await releaseRuntimeEvent(db, "Ev_retry", owner.claimToken);
    expect(await claimRuntimeEvent(db, "Ev_retry", 1_001)).toMatchObject({ disposition: "claimed" });
  });

  it("fences a stale worker after crash recovery reclaims the runtime event", async () => {
    const db = storage();
    const stale = await claimRuntimeEvent(db, "Ev_crash", 1_000);
    expect(await claimRuntimeEvent(db, "Ev_crash", 5 * 60 * 1_000 + 1_001))
      .toMatchObject({ disposition: "in_progress" });
    const recovered = await claimRuntimeEvent(db, "Ev_crash", 15 * 60 * 1_000 + 1_001);
    if (stale.disposition !== "claimed" || recovered.disposition !== "claimed") {
      throw new Error("expected_reclaimed_owners");
    }

    await expect(releaseRuntimeEvent(db, "Ev_crash", stale.claimToken))
      .rejects.toThrow("runtime_event_claim_conflict");
    await expect(completeRuntimeEvent(db, "Ev_crash", stale.claimToken, "old.1", 15 * 60 * 1_000 + 1_002))
      .rejects.toThrow("runtime_event_claim_conflict");
    await completeRuntimeEvent(db, "Ev_crash", recovered.claimToken, "new.1", 15 * 60 * 1_000 + 1_003);
    expect(await claimRuntimeEvent(db, "Ev_crash", 99_999_999))
      .toEqual({ disposition: "completed", responseTs: "new.1" });
  });

  it("rejects invalid event ids", async () => {
    await expect(claimRuntimeEvent(storage(), "../bad", 1_000)).rejects.toThrow("event_id_invalid");
  });

  it("uses the Slack message timestamp across app_mention and message event ids", () => {
    const base = { tenantId: "unson-business", workspaceId: "T_UNSON", channelId: "C_DEV",
      threadTs: "1786689957.919239", messageTs: "1786689957.919239", text: "hello", receivedAt: "2026-08-14T00:00:00Z" };
    expect(runtimeDeliveryId({ ...base, eventId: "EvMention", eventType: "app_mention" }))
      .toBe(runtimeDeliveryId({ ...base, eventId: "EvMessage", eventType: "message" }));
  });

  it("releases a silent ambient claim so the canonical mention can still be processed", async () => {
    const db = storage();
    const ambient = { eventId: "EvMessage", eventType: "message" as const, messageTs: "1786677816.307859" };
    const mention = { eventId: "EvMention", eventType: "app_mention" as const, messageTs: ambient.messageTs };
    const deliveryId = runtimeDeliveryId(ambient);
    expect(runtimeDeliveryId(mention)).toBe(deliveryId);

    const ambientClaim = await claimRuntimeEvent(db, deliveryId, 1_000);
    if (ambientClaim.disposition !== "claimed") throw new Error("expected_ambient_claim");
    expect(runtimeClaimSettlement({ outcome: "ignored" })).toBe("release");
    expect(runtimeClaimSettlement({ outcome: "reacted", responseTs: ambient.messageTs })).toBe("release");
    await releaseRuntimeEvent(db, deliveryId, ambientClaim.claimToken);

    expect(await claimRuntimeEvent(db, runtimeDeliveryId(mention), 1_001))
      .toMatchObject({ disposition: "claimed" });
  });
});
