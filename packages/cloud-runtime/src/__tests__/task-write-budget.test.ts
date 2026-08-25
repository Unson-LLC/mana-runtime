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

function body(fingerprint: string, callIndex = 1) {
  return {
    requestId: "Ev123",
    nonce: "Ev123",
    placementId: "mana-accounting",
    actorId: "U1",
    project: "back-office",
    operation: "task.create",
    callIndex,
    budget: 3,
    expiresAt: Date.now() + 60_000,
    fingerprint,
  };
}

function claim(fingerprint: string, callIndex = 1, extra: Record<string, unknown> = {}) {
  return new Request("https://task-write-budget.internal/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body(fingerprint, callIndex), ...extra }),
  });
}

function experiment(overrides: Record<string, unknown> = {}) {
  const startsAt = Date.now() - 1_000;
  return {
    id: "mana-autonomy-24h-v0",
    actorId: "mana_autonomy_v0",
    project: "brainbase-deployment",
    startsAt,
    expiresAt: startsAt + 60 * 60 * 1000,
    maxWrites: 2,
    disabled: false,
    ...overrides,
  };
}

describe("durable task write budget", () => {
  it("accepts an exact retry but rejects reuse of a slot for another mutation", async () => {
    const durable = new TaskWriteBudget(state().durableState);
    const first = await durable.fetch(claim("a".repeat(64)));
    const retry = await durable.fetch(claim("a".repeat(64)));
    const reused = await durable.fetch(claim("b".repeat(64)));
    expect(first.status).toBe(204);
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({ disposition: "replay" });
    expect(reused.status).toBe(409);
    await expect(reused.json()).resolves.toEqual({ error: "task_write_budget_slot_reused" });
  });

  it("allows only the capability budget and removes state after expiry", async () => {
    const current = state();
    const durable = new TaskWriteBudget(current.durableState);
    for (let index = 1; index <= 3; index += 1) {
      expect((await durable.fetch(claim(String(index).repeat(64), index))).status).toBe(204);
    }
    expect(current.values.get("request:Ev123:Ev123:count")).toBe(3);
    await durable.alarm();
    expect(current.values.size).toBe(0);
  });

  it("fails closed when the autonomy kill switch is active", async () => {
    const durable = new TaskWriteBudget(state().durableState);
    const response = await durable.fetch(claim("c".repeat(64), 1, {
      actorId: "mana_autonomy_v0",
      project: "brainbase-deployment",
      experiment: experiment({ disabled: true }),
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "autonomy_kill_switch_active" });
  });

  it("enforces one total write budget across multiple autonomy requests", async () => {
    const current = state();
    const durable = new TaskWriteBudget(current.durableState);
    const guard = experiment({ maxWrites: 2 });
    const first = await durable.fetch(claim("d".repeat(64), 1, {
      requestId: "run-1", nonce: "run-1", actorId: "mana_autonomy_v0", project: "brainbase-deployment", experiment: guard,
    }));
    const second = await durable.fetch(claim("e".repeat(64), 1, {
      requestId: "run-2", nonce: "run-2", actorId: "mana_autonomy_v0", project: "brainbase-deployment", experiment: guard,
    }));
    const third = await durable.fetch(claim("f".repeat(64), 1, {
      requestId: "run-3", nonce: "run-3", actorId: "mana_autonomy_v0", project: "brainbase-deployment", experiment: guard,
    }));
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(third.status).toBe(429);
    expect(current.values.get("experiment:write-count")).toBe(2);
  });

  it("rejects an expired experiment and a capability that outlives it", async () => {
    const durable = new TaskWriteBudget(state().durableState);
    const expired = experiment({ startsAt: Date.now() - 10_000, expiresAt: Date.now() - 1 });
    const expiredResponse = await durable.fetch(claim("1".repeat(64), 1, {
      actorId: "mana_autonomy_v0", project: "brainbase-deployment", experiment: expired,
    }));
    expect(expiredResponse.status).toBe(403);
    await expect(expiredResponse.json()).resolves.toEqual({ error: "autonomy_experiment_expired" });

    const guard = experiment({ expiresAt: Date.now() + 10_000 });
    const outlives = await durable.fetch(claim("2".repeat(64), 1, {
      actorId: "mana_autonomy_v0", project: "brainbase-deployment",
      expiresAt: Date.now() + 20_000,
      experiment: guard,
    }));
    expect(outlives.status).toBe(403);
    await expect(outlives.json()).resolves.toEqual({ error: "autonomy_capability_outlives_experiment" });
  });

  it("persists a claimed receipt and marks it completed with the result reference", async () => {
    const current = state();
    const durable = new TaskWriteBudget(current.durableState);
    const fingerprint = "3".repeat(64);
    expect((await durable.fetch(claim(fingerprint))).status).toBe(204);
    const claimed = await durable.fetch(new Request(`https://task-write-budget.internal/receipt?fingerprint=${fingerprint}`));
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toMatchObject({ fingerprint, state: "claimed", requestId: "Ev123" });

    const completed = await durable.fetch(new Request("https://task-write-budget.internal/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fingerprint, resultRef: "task-1" }),
    }));
    expect(completed.status).toBe(204);
    const receipt = await durable.fetch(new Request(`https://task-write-budget.internal/receipt?fingerprint=${fingerprint}`));
    await expect(receipt.json()).resolves.toMatchObject({ state: "completed", resultRef: "task-1" });
  });
});