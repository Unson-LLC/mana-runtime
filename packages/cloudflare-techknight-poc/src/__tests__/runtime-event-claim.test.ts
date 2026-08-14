import { claimRuntimeEvent, completeRuntimeEvent, releaseRuntimeEvent, runtimeDeliveryId } from "../runtime-event-claim.js";

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
    expect(await claimRuntimeEvent(db, "Ev_same", 1_000)).toBe(true);
    expect(await claimRuntimeEvent(db, "Ev_same", 1_001)).toBe(false);
    await completeRuntimeEvent(db, "Ev_same", "1700.1", 1_100);
    expect(await claimRuntimeEvent(db, "Ev_same", 9_999_999)).toBe(false);
  });

  it("releases a failed event so a queue retry can process it", async () => {
    const db = storage();
    expect(await claimRuntimeEvent(db, "Ev_retry", 1_000)).toBe(true);
    await releaseRuntimeEvent(db, "Ev_retry");
    expect(await claimRuntimeEvent(db, "Ev_retry", 1_001)).toBe(true);
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
});
