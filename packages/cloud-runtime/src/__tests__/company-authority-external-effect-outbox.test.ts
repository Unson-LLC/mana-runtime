import { describe, expect, it, vi } from "vitest";
import {
  ExternalEffectOutboxMemoryStore,
  processCompanyAuthorityExternalEffect,
  reconcileCompanyAuthorityExternalEffect,
  type ExternalEffectOutboxRecord,
} from "../multitenancy/company-authority-external-effect-outbox.js";
import type { AcceptedCompanyAuthorityContext } from "../multitenancy/company-authority-runtime-adapter.js";
import {
  createDurableExternalEffectOutboxClient,
  createDurableExternalEffectOutboxStore,
  TenantRuntimeStateHandler,
  type TenantStateTransaction,
} from "../multitenancy/tenant-runtime-state.js";

class MemoryStorage implements TenantStateTransaction {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async transaction<T>(callback: (transaction: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

class TenantRuntimeNamespace {
  readonly handlers = new Map<string, TenantRuntimeStateHandler>();
  readonly storages = new Map<string, MemoryStorage>();

  idFromName(name: string): string { return name; }

  get(id: unknown): { fetch(request: Request): Promise<Response> } {
    const key = String(id);
    return {
      fetch: (request) => {
        let handler = this.handlers.get(key);
        if (!handler) {
          const storage = new MemoryStorage();
          this.storages.set(key, storage);
          handler = new TenantRuntimeStateHandler(storage, key);
          this.handlers.set(key, handler);
        }
        return handler.fetch(request);
      },
    };
  }
}

function context(effectId = "idem_external_1"): AcceptedCompanyAuthorityContext {
  return {
    schema_version: "1.0",
    tenant_context: { idempotency_key: effectId, tenant: { tenant_id: "ten_company_authority" } },
    actor: {},
    scope: {},
    authority: { decision: "auto" },
    evidence: {},
    issued_at: "2026-09-02T00:00:00.000Z",
    expires_at: "2026-09-02T01:00:00.000Z",
    integrity: {},
  };
}

describe("company authority external effect outbox", () => {
  it("persists pending before provider send and reuses its deterministic provider key", async () => {
    const outbox = new ExternalEffectOutboxMemoryStore();
    const observed: ExternalEffectOutboxRecord[] = [];
    const providerSend = vi.fn(async ({ provider_key }: { provider_key: string }) => {
      const pending = await outbox.read("ten_company_authority", "idem_external_1");
      if (pending) observed.push(pending);
      return { applied: true as const, response_observed: true as const, result_ref: provider_key };
    });

    const first = await processCompanyAuthorityExternalEffect({
      context: context(), payload: { value: 1 }, outbox, provider_send: providerSend,
    });
    const duplicate = await processCompanyAuthorityExternalEffect({
      context: context(), payload: { value: 1 }, outbox, provider_send: providerSend,
    });

    expect(observed).toEqual([expect.objectContaining({ state: "in_flight" })]);
    expect(first).toMatchObject({ state: "succeeded" });
    expect(duplicate).toEqual(first);
    expect(providerSend).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an effect id is reused with another payload", async () => {
    const outbox = new ExternalEffectOutboxMemoryStore();
    await processCompanyAuthorityExternalEffect({
      context: context(), payload: { value: 1 }, outbox,
      provider_send: async () => ({ applied: true, response_observed: true, result_ref: "one" }),
    });

    await expect(processCompanyAuthorityExternalEffect({
      context: context(), payload: { value: 2 }, outbox,
      provider_send: async () => ({ applied: true, response_observed: true, result_ref: "two" }),
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("resumes a persisted pending effect because no provider call started", async () => {
    const providerSend = vi.fn(async ({ provider_key: _providerKey }: { provider_key: string }) => ({
      applied: true as const,
      response_observed: true as const,
      result_ref: "provider:pending-recovery",
    }));
    let persisted: ExternalEffectOutboxRecord | null = null;
    const interceptingStore = {
      begin: vi.fn(async (record: ExternalEffectOutboxRecord) => ({ record, created: false })),
      claim: vi.fn(async (record: ExternalEffectOutboxRecord) => ({ record, claimed: true })),
      write: vi.fn(async (record: ExternalEffectOutboxRecord) => { persisted = record; }),
      read: vi.fn(async () => persisted),
    };

    const result = await processCompanyAuthorityExternalEffect({
      context: context(), payload: { value: 1 }, outbox: interceptingStore, provider_send: providerSend,
    });

    expect(result).toMatchObject({ state: "succeeded" });
    expect(providerSend).toHaveBeenCalledTimes(1);
  });

  it("retries an active in-flight redelivery without resending before lease expiry", async () => {
    let persisted: ExternalEffectOutboxRecord | null = null;
    const providerSend = vi.fn();
    const outbox = {
      begin: vi.fn(async (record: ExternalEffectOutboxRecord) => ({
        record: { ...record, state: "in_flight" as const },
        created: false,
      })),
      claim: vi.fn(async (record: ExternalEffectOutboxRecord) => ({
        record: { ...record, state: "in_flight" as const },
        claimed: false,
      })),
      write: vi.fn(async (record: ExternalEffectOutboxRecord) => { persisted = record; }),
      read: vi.fn(async () => persisted),
    };

    await expect(processCompanyAuthorityExternalEffect({
      context: context(), payload: { value: 1 }, outbox, provider_send: providerSend,
    })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });

    expect(providerSend).not.toHaveBeenCalled();
  });

  it("does not throw into Queue retry after provider invocation when terminal storage fails", async () => {
    let writes = 0;
    const outbox = {
      begin: vi.fn(async (record: ExternalEffectOutboxRecord) => ({ record, created: true })),
      claim: vi.fn(async (record: ExternalEffectOutboxRecord) => ({ record, claimed: true })),
      write: vi.fn(async () => {
        writes += 1;
        if (writes > 0) throw new Error("storage unavailable");
      }),
      read: vi.fn(async () => null),
    };
    const providerSend = vi.fn(async () => ({
      applied: true as const,
      response_observed: true as const,
      result_ref: "provider:committed",
    }));

    const result = await processCompanyAuthorityExternalEffect({
      context: context(), payload: { value: 1 }, outbox, provider_send: providerSend,
    });

    expect(result).toMatchObject({ state: "in_flight" });
    expect(providerSend).toHaveBeenCalledTimes(1);
  });

  it("atomically claims a pending effect so concurrent deliveries call the provider once", async () => {
    const outbox = new ExternalEffectOutboxMemoryStore();
    let releaseProvider: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const providerSend = vi.fn(async () => {
      signalStarted?.();
      await providerStarted;
      return { applied: true as const, response_observed: true as const, result_ref: "provider:once" };
    });

    const first = processCompanyAuthorityExternalEffect({
      context: context(), payload: { value: 1 }, outbox, provider_send: providerSend,
    });
    await started;
    const concurrent = processCompanyAuthorityExternalEffect({
      context: context(), payload: { value: 1 }, outbox, provider_send: providerSend,
    });
    await expect(concurrent).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    releaseProvider?.();
    const completed = await first;

    expect(completed).toMatchObject({ state: "succeeded" });
    expect(providerSend).toHaveBeenCalledTimes(1);
  });

  it("partitions identical effect ids by tenant", async () => {
    const outbox = new ExternalEffectOutboxMemoryStore();
    const providerSend = vi.fn(async ({ provider_key: _providerKey }: { provider_key: string }) => ({
      applied: true as const,
      response_observed: true as const,
      result_ref: "provider:ok",
    }));
    const otherTenant = context();
    (otherTenant.tenant_context as { tenant: { tenant_id: string } }).tenant.tenant_id = "ten_other";

    await processCompanyAuthorityExternalEffect({
      context: context(), payload: { value: 1 }, outbox, provider_send: providerSend,
    });
    await processCompanyAuthorityExternalEffect({
      context: otherTenant, payload: { value: 1 }, outbox, provider_send: providerSend,
    });

    expect(providerSend).toHaveBeenCalledTimes(2);
    expect(providerSend.mock.calls[0]?.[0].provider_key)
      .not.toBe(providerSend.mock.calls[1]?.[0].provider_key);
    await expect(outbox.read("ten_company_authority", "idem_external_1"))
      .resolves.toMatchObject({ tenant_id: "ten_company_authority" });
    await expect(outbox.read("ten_other", "idem_external_1"))
      .resolves.toMatchObject({ tenant_id: "ten_other" });
  });

  it("reconciles an unknown result by provider key without resending", async () => {
    const outbox = new ExternalEffectOutboxMemoryStore();
    const providerSend = vi.fn(async () => ({ applied: true as const, response_observed: false as const }));
    await processCompanyAuthorityExternalEffect({
      context: context(), payload: { value: 1 }, outbox, provider_send: providerSend,
    });
    const providerReconcile = vi.fn(async () => ({ state: "succeeded" as const, result_ref: "provider:1" }));

    const reconciled = await reconcileCompanyAuthorityExternalEffect({
      tenant_id: "ten_company_authority", effect_id: "idem_external_1", outbox,
      provider_reconcile: providerReconcile,
    });

    expect(reconciled).toMatchObject({ state: "succeeded", result_ref: "provider:1" });
    expect(providerSend).toHaveBeenCalledTimes(1);
    expect(providerReconcile).toHaveBeenCalledTimes(1);
  });

  it("retains unknown when provider reconciliation is unavailable", async () => {
    const outbox = new ExternalEffectOutboxMemoryStore();
    await processCompanyAuthorityExternalEffect({
      context: context(), payload: { value: 1 }, outbox,
      provider_send: async () => { throw new Error("response lost"); },
    });

    const reconciled = await reconcileCompanyAuthorityExternalEffect({
      tenant_id: "ten_company_authority", effect_id: "idem_external_1", outbox,
      provider_reconcile: async () => { throw new Error("unavailable"); },
    });

    expect(reconciled).toMatchObject({ state: "unknown_requires_reconcile" });
  });

  it("persists terminal state across durable store instances", async () => {
    const storage = new MemoryStorage();
    const pending: ExternalEffectOutboxRecord = {
      tenant_id: "ten_company_authority",
      effect_id: "idem_external_1",
      provider_key: "provider-key",
      payload_hash: "sha256:payload",
      state: "pending",
    };
    const scope = { tenant_id: pending.tenant_id, effect_id: pending.effect_id };
    const claimed = {
      ...pending,
      state: "in_flight" as const,
      claim_token: "claim-1",
      claim_expires_at: Date.now() + 60_000,
    };
    const firstStore = createDurableExternalEffectOutboxStore(storage, scope);
    await firstStore.begin(pending);
    await firstStore.claim(claimed);
    await firstStore.write({ ...claimed, state: "unknown_requires_reconcile" });

    const rehydratedStore = createDurableExternalEffectOutboxStore(storage, scope);
    await expect(rehydratedStore.read(pending.tenant_id, pending.effect_id)).resolves.toEqual({
      ...claimed,
      state: "unknown_requires_reconcile",
    });
    await expect(rehydratedStore.begin({ ...pending, payload_hash: "sha256:other" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(rehydratedStore.read("ten_other", pending.effect_id))
      .rejects.toMatchObject({ code: "CROSS_TENANT_CANDIDATE" });
  });

  it("persists a tenant and effect scoped outbox through the durable object client", async () => {
    const namespace = new TenantRuntimeNamespace();
    const scope = { tenant_id: "ten_company_authority", effect_id: "idem_external_1" };
    const outbox = createDurableExternalEffectOutboxClient(namespace, scope);
    const pending: ExternalEffectOutboxRecord = {
      ...scope,
      provider_key: "provider-key",
      payload_hash: "sha256:payload",
      state: "pending",
    };

    await expect(outbox.begin(pending)).resolves.toMatchObject({ created: true });
    const claimed = {
      ...pending,
      state: "in_flight" as const,
      claim_token: "claim-1",
      claim_expires_at: Date.now() + 60_000,
    };
    await expect(outbox.claim(claimed))
      .resolves.toMatchObject({ claimed: true });
    await outbox.write({ ...claimed, state: "unknown_requires_reconcile" });

    const restarted = createDurableExternalEffectOutboxClient(namespace, scope);
    await expect(restarted.read(scope.tenant_id, scope.effect_id)).resolves.toEqual({
      ...claimed,
      state: "unknown_requires_reconcile",
    });
    await expect(restarted.read("ten_other", scope.effect_id))
      .rejects.toMatchObject({ code: "CROSS_TENANT_CANDIDATE" });
    const handler = namespace.handlers.values().next().value as TenantRuntimeStateHandler;
    const crossScope = await handler.fetch(new Request(
      "https://tenant-runtime-state.internal/external-effect/read",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenant_id: "ten_other", effect_id: scope.effect_id }),
      },
    ));
    await expect(crossScope.json()).resolves.toEqual({ error: "CROSS_TENANT_CANDIDATE" });
    expect(crossScope.status).toBe(409);
    expect([...namespace.storages.keys()]).toEqual([
      'external-effect:["ten_company_authority","idem_external_1"]',
    ]);
  });

  it("rejects fresh-object scope poisoning and invalid RPC input before binding storage", async () => {
    const storage = new MemoryStorage();
    const handler = new TenantRuntimeStateHandler(
      storage,
      'external-effect:["ten_company_authority","idem_external_1"]',
    );
    const request = (path: string, body: unknown) => handler.fetch(new Request(
      `https://tenant-runtime-state.internal${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ));

    const poisoned = await request("/external-effect/read", {
      tenant_id: "ten_other",
      effect_id: "idem_external_1",
    });
    expect(poisoned.status).toBe(409);
    await expect(poisoned.json()).resolves.toEqual({ error: "CROSS_TENANT_CANDIDATE" });

    const invalidState = await request("/external-effect/begin", {
      tenant_id: "ten_company_authority",
      effect_id: "idem_external_1",
      provider_key: "provider-key",
      payload_hash: "sha256:payload",
      state: "succeeded",
    });
    expect(invalidState.status).toBe(409);
    await expect(invalidState.json()).resolves.toEqual({ error: "EXTERNAL_EFFECT_STATE_CONFLICT" });

    const unknownPath = await request("/external-effect/unknown", {
      tenant_id: "ten_company_authority",
      effect_id: "idem_external_1",
    });
    expect(unknownPath.status).toBe(404);
    await expect(storage.get("external-effect-outbox:scope")).resolves.toBeUndefined();
  });

  it("reads back its durable claim when the RPC response is lost", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:00.000Z"));
    try {
      const namespace = new TenantRuntimeNamespace();
      const scope = { tenant_id: "ten_company_authority", effect_id: "idem_external_1" };
      const durable = createDurableExternalEffectOutboxClient(namespace, scope);
      let loseClaimResponse = true;
      const responseLosingOutbox = {
        ...durable,
        claim: async (record: ExternalEffectOutboxRecord) => {
          const result = await durable.claim(record);
          if (loseClaimResponse) {
            loseClaimResponse = false;
            throw new Error("claim response lost");
          }
          return result;
        },
      };
      const providerSend = vi.fn(async (_input: { provider_key: string; payload: { value: number } }) => ({
        applied: true as const,
        response_observed: true as const,
        result_ref: "provider:committed",
      }));

      await expect(processCompanyAuthorityExternalEffect({
        context: context(), payload: { value: 1 }, outbox: responseLosingOutbox,
        provider_send: providerSend, claim_lease_ms: 1_000,
      })).resolves.toMatchObject({ state: "succeeded", result_ref: "provider:committed" });
      expect(providerSend).toHaveBeenCalledTimes(1);
      expect(providerSend.mock.calls[0]?.[0].provider_key).toMatch(/^sha256:/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a lost worker claim until lease expiry, then reclaims it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:00.000Z"));
    try {
      const namespace = new TenantRuntimeNamespace();
      const scope = { tenant_id: "ten_company_authority", effect_id: "idem_external_1" };
      const durable = createDurableExternalEffectOutboxClient(namespace, scope);
      const crashedWorkerOutbox = {
        ...durable,
        claim: async (record: ExternalEffectOutboxRecord) => {
          await durable.claim(record);
          throw new Error("worker lost after claim");
        },
        read: async () => null,
      };
      const providerSend = vi.fn(async () => ({
        applied: true as const,
        response_observed: true as const,
        result_ref: "provider:reclaimed",
      }));

      await expect(processCompanyAuthorityExternalEffect({
        context: context(), payload: { value: 1 }, outbox: crashedWorkerOutbox,
        provider_send: providerSend, claim_lease_ms: 1_000,
      })).rejects.toThrow("worker lost after claim");
      await expect(processCompanyAuthorityExternalEffect({
        context: context(), payload: { value: 1 }, outbox: durable,
        provider_send: providerSend, claim_lease_ms: 1_000,
      })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
      expect(providerSend).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_001);
      await expect(processCompanyAuthorityExternalEffect({
        context: context(), payload: { value: 1 }, outbox: durable,
        provider_send: providerSend, claim_lease_ms: 1_000,
      })).resolves.toMatchObject({ state: "succeeded", result_ref: "provider:reclaimed" });
      expect(providerSend).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences a stale worker after a durable claim is reclaimed", async () => {
    let now = 1_000;
    const storage = new MemoryStorage();
    const pending: ExternalEffectOutboxRecord = {
      tenant_id: "ten_company_authority",
      effect_id: "idem_external_1",
      provider_key: "provider-key",
      payload_hash: "sha256:payload",
      state: "pending",
    };
    const store = createDurableExternalEffectOutboxStore(storage, pending, () => now);
    const firstClaim = {
      ...pending,
      state: "in_flight" as const,
      claim_token: "claim-old",
      claim_expires_at: 2_000,
    };
    const reclaimed = {
      ...firstClaim,
      claim_token: "claim-new",
      claim_expires_at: 3_001,
    };
    await store.begin(pending);
    await expect(store.claim(firstClaim)).resolves.toMatchObject({ claimed: true });
    now = 2_001;
    await expect(store.claim(reclaimed)).resolves.toMatchObject({ claimed: true });

    await expect(store.write({ ...firstClaim, state: "succeeded", result_ref: "provider:stale" }))
      .rejects.toMatchObject({ code: "EXTERNAL_EFFECT_CLAIM_CONFLICT" });
    await expect(store.write({ ...reclaimed, state: "succeeded", result_ref: "provider:current" }))
      .resolves.toBeUndefined();
  });
});
