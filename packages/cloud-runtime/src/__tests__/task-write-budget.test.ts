import { TaskWriteBudget } from "../task-write-budget.js";

function state() {
  const values = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
    setAlarm: vi.fn(async () => undefined),
    deleteAll: vi.fn(async () => { values.clear(); }),
    transaction: vi.fn(async <T>(closure: (transaction: { get: typeof storage.get; put: typeof storage.put }) => Promise<T>) => closure(storage)),
  };
  return {
    durableState: { storage } as unknown as ConstructorParameters<typeof TaskWriteBudget>[0],
    values,
  };
}

function claim(fingerprint: string, callIndex = 1) {
  return new Request("https://task-write-budget.internal/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "Ev123",
      nonce: "Ev123",
      placementId: "mana-accounting",
      callIndex,
      budget: 3,
      expiresAt: Date.now() + 60_000,
      fingerprint,
    }),
  });
}

describe("durable task write budget", () => {
  it("accepts an exact retry but rejects reuse of a slot for another mutation", async () => {
    const durable = new TaskWriteBudget(state().durableState);
    const first = await durable.fetch(claim("a".repeat(64)));
    const retry = await durable.fetch(claim("a".repeat(64)));
    const reused = await durable.fetch(claim("b".repeat(64)));
    expect(first.status).toBe(204);
    expect(retry.status).toBe(204);
    expect(reused.status).toBe(409);
    await expect(reused.json()).resolves.toEqual({ error: "task_write_budget_slot_reused" });
  });

  it("allows only the capability budget and removes state after expiry", async () => {
    const current = state();
    const durable = new TaskWriteBudget(current.durableState);
    for (let index = 1; index <= 3; index += 1) {
      expect((await durable.fetch(claim(String(index).repeat(64), index))).status).toBe(204);
    }
    expect(current.values.get("count")).toBe(3);
    await durable.alarm();
    expect(current.values.size).toBe(0);
  });
});
