import { describe, expect, it } from "vitest";
import {
  claimDevelopmentCallbackState,
  recordDevelopmentCallbackDeliveryState,
} from "../multitenancy/development-callback-state.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> { return Promise.resolve(this.values.get(key) as T | undefined); }
  put(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); return Promise.resolve(); }
  transaction<T>(callback: (transaction: MemoryStorage) => Promise<T>): Promise<T> { return callback(this); }
}

const payload = {
  job_id: "job_1", event_id: "Ev1", placement_id: "placement-a", workspace_id: "T1",
  channel_id: "C1", thread_ts: "1.0", requester_id: "U1", status: "completed" as const,
  summary: "done", quota_decision: "allowed" as const,
};

describe("development callback durable fencing", () => {
  it("rejects a stale writer after the callback lease is reclaimed", async () => {
    const storage = new MemoryStorage();
    const first = await claimDevelopmentCallbackState(storage, "development:job_1", payload, 1_000);
    const second = await claimDevelopmentCallbackState(storage, "development:job_1", payload, 11_001);
    expect(first).toEqual({ state: "claimed", fence: 1 });
    expect(second).toEqual({ state: "claimed", fence: 2 });

    await expect(recordDevelopmentCallbackDeliveryState(storage, "development:job_1", payload,
      { state: "failed" }, 1, "1970-01-01T00:00:11.002Z"))
      .rejects.toMatchObject({ code: "REPLY_OWNERSHIP_CONFLICT" });
    await expect(recordDevelopmentCallbackDeliveryState(storage, "development:job_1", payload,
      { state: "delivered", responseTs: "2.0" }, 2, "1970-01-01T00:00:11.003Z"))
      .resolves.toBeUndefined();
  });
});
