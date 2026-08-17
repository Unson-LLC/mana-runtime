import { describe, expect, it, vi } from "vitest";

import {
  DevelopmentTerminalOutboxHandler,
  createDevelopmentTerminalOutboxClient,
} from "../multitenancy/development-terminal-outbox.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt?: number;
  get<T>(key: string): Promise<T | undefined> { return Promise.resolve(this.values.get(key) as T | undefined); }
  put(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); return Promise.resolve(); }
  delete(key: string): Promise<boolean> { return Promise.resolve(this.values.delete(key)); }
  transaction<T>(callback: (transaction: MemoryStorage) => Promise<T>): Promise<T> { return callback(this); }
  setAlarm(value: number | Date): Promise<void> {
    this.alarmAt = value instanceof Date ? value.getTime() : value;
    return Promise.resolve();
  }
}

const submission = {
  job_id: "development-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
  payload_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  callback_body: JSON.stringify({ job_id: "development-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", status: "timed_out" }),
  tenant_boundary_handle: "tb_opaque_operation_handle_1234567890",
  owner: { tenantId: "tenant-a", jobId: "development-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG" },
  owner_claim: { key: "ik1_owner", partition_key: "tenant-partition-a" },
  terminal_deadline_at: "2026-08-17T10:04:00.000Z",
  observed_at: "2026-08-17T10:03:30.000Z",
} as never;

describe("development terminal outbox", () => {
  it("persists the exact callback before delivery and retries it after an isolate restart", async () => {
    const storage = new MemoryStorage();
    const first = new DevelopmentTerminalOutboxHandler(storage, storage);
    const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => first.fetch(request) }) };
    const client = createDevelopmentTerminalOutboxClient(namespace, "tenant-partition-a");

    await expect(client.submit(submission)).resolves.toMatchObject({ state: "pending" });
    expect(storage.alarmAt).toBe(Date.parse("2026-08-17T10:03:30.000Z"));

    const retry = vi.fn()
      .mockResolvedValueOnce({ state: "retry", error: "UPSTREAM_UNAVAILABLE" })
      .mockResolvedValueOnce({ state: "completed" });
    await first.alarm("2026-08-17T10:03:31.000Z", retry);

    const restarted = new DevelopmentTerminalOutboxHandler(storage, storage);
    await restarted.alarm("2026-08-17T10:03:33.000Z", retry);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(retry.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      callback_body: submission.callback_body,
      payload_hash: submission.payload_hash,
    }));
    await expect(client.read()).resolves.toMatchObject({ state: "completed" });
  });

  it("rejects the same job id with a different terminal payload", async () => {
    const storage = new MemoryStorage();
    const handler = new DevelopmentTerminalOutboxHandler(storage, storage);
    const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => handler.fetch(request) }) };
    const client = createDevelopmentTerminalOutboxClient(namespace, "tenant-partition-a");
    await client.submit(submission);

    await expect(client.submit({ ...submission,
      payload_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      callback_body: JSON.stringify({ job_id: submission.job_id, status: "completed" }),
    } as never)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
