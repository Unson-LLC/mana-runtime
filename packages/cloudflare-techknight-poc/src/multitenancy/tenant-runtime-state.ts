import type {
  AccountingLedgerClaim,
  AccountingLedgerResult,
  TenantAccountingLedgerStore,
} from "./accounting.js";
import type {
  IdempotencyClaim,
  IdempotencyClaimInput,
  IdempotencyCompleteInput,
  IdempotencyStore,
} from "./idempotency.js";
import { deny, TenantBoundaryError } from "./errors.js";
import { tenantPartitionKey } from "./isolation.js";
import type { TenantContextEnvelope } from "./contracts.js";

export interface TenantStateTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
}

export interface TenantStateStorage extends TenantStateTransaction {
  transaction<T>(callback: (transaction: TenantStateTransaction) => Promise<T>): Promise<T>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function idempotencyStorageKey(partitionKey: string): string {
  return `idempotency:${partitionKey}`;
}

function createStoredClaim(input: IdempotencyClaimInput): IdempotencyClaim {
  return {
    ...clone(input),
    state: "claimed",
    partition_key: tenantPartitionKey({
      tenant_id: input.tenant_id,
      resource_type: "idempotency",
      connection_id: input.connection_id,
      workspace_id: "",
      channel_id: "",
      thread_ts: "",
      resource_id: input.key,
    }),
  };
}

function assertCompletionWindow(input: IdempotencyCompleteInput): void {
  const updatedAt = Date.parse(input.updated_at);
  const retainedUntil = Date.parse(input.retained_until);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(retainedUntil)
    || retainedUntil - updatedAt < 30 * 24 * 60 * 60 * 1_000) {
    deny("idempotency", "IDEMPOTENCY_RETENTION_INVALID");
  }
}

class DurableTenantStateStore implements IdempotencyStore {
  readonly #partitionKeys = new Map<string, string>();

  constructor(private readonly storage: TenantStateStorage) {}

  async claim(input: IdempotencyClaimInput): Promise<{ created: boolean; value: IdempotencyClaim }> {
    return this.storage.transaction(async (transaction) => {
      const stored = createStoredClaim(input);
      const key = idempotencyStorageKey(stored.partition_key);
      const existing = await transaction.get<IdempotencyClaim>(key);
      if (existing) {
        this.#partitionKeys.set(input.key, existing.partition_key);
        return { created: false, value: clone(existing) };
      }
      await transaction.put(key, stored);
      this.#partitionKeys.set(input.key, stored.partition_key);
      return { created: true, value: clone(stored) };
    });
  }

  async read(key: string): Promise<IdempotencyClaim | undefined> {
    const partitionKey = this.#partitionKeys.get(key);
    if (!partitionKey) return undefined;
    const value = await this.storage.get<IdempotencyClaim>(idempotencyStorageKey(partitionKey));
    return value ? clone(value) : undefined;
  }

  async storageReadByPartition(partitionKey: string): Promise<IdempotencyClaim | undefined> {
    const value = await this.storage.get<IdempotencyClaim>(idempotencyStorageKey(partitionKey));
    return value ? clone(value) : undefined;
  }

  async release(key: string, tenantId: string, inputPartitionKey?: string): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const partitionKey = inputPartitionKey ?? this.#partitionKeys.get(key);
      if (!partitionKey) deny("idempotency", "IDEMPOTENCY_CLAIM_MISSING");
      const storageKey = idempotencyStorageKey(partitionKey);
      const current = await transaction.get<IdempotencyClaim>(storageKey);
      if (!current) return;
      if (current.tenant_id !== tenantId) deny("idempotency", "CROSS_TENANT_CANDIDATE");
      if (current.state === "claimed") await transaction.delete(storageKey);
      this.#partitionKeys.delete(key);
    });
  }

  async complete(input: IdempotencyCompleteInput): Promise<IdempotencyClaim> {
    assertCompletionWindow(input);
    return this.storage.transaction(async (transaction) => {
      const partitionKey = input.partition_key ?? this.#partitionKeys.get(input.key);
      if (!partitionKey) deny("idempotency", "IDEMPOTENCY_CLAIM_MISSING");
      const key = idempotencyStorageKey(partitionKey);
      const current = await transaction.get<IdempotencyClaim>(key);
      if (!current) deny("idempotency", "IDEMPOTENCY_CLAIM_MISSING");
      if (current.tenant_id !== input.tenant_id) deny("idempotency", "CROSS_TENANT_CANDIDATE");
      const completed: IdempotencyClaim = {
        ...current,
        state: input.state,
        ...(input.result_ref ? { result_ref: input.result_ref } : {}),
        updated_at: input.updated_at,
        retained_until: input.retained_until,
      };
      await transaction.put(key, completed);
      this.#partitionKeys.set(input.key, completed.partition_key);
      return clone(completed);
    });
  }

  async claimAccounting(input: {
    tenant_context: TenantContextEnvelope;
    usage_event_ids: readonly string[];
    receipt_id: string;
    payload_hash: string;
  }): Promise<AccountingLedgerResult> {
    const entityKeys = [...input.usage_event_ids, input.receipt_id].map((resourceId) => tenantPartitionKey({
      tenant_id: input.tenant_context.tenant.tenant_id,
      resource_type: "usage",
      connection_id: input.tenant_context.workspace_connection.connection_id,
      workspace_id: input.tenant_context.workspace_connection.workspace_id,
      channel_id: input.tenant_context.slack.channel_id,
      thread_ts: input.tenant_context.slack.thread_ts ?? "",
      resource_id: resourceId,
    }));
    const batchKey = JSON.stringify([entityKeys, input.payload_hash]);
    return this.storage.transaction(async (transaction) => {
      const entries = await Promise.all(entityKeys.map((key) => transaction.get<{
        batch_key: string;
        state: "claimed" | "written";
      }>(`accounting:${key}`)));
      if (entries.every((entry) => entry?.state === "written" && entry.batch_key === batchKey)) {
        return { disposition: "duplicate" };
      }
      if (entries.every((entry) => entry?.state === "claimed" && entry.batch_key === batchKey)) {
        return { disposition: "claimed", batch_key: batchKey, entity_keys: entityKeys };
      }
      if (entries.some((entry) => entry !== undefined)) deny("brainbase_proxy", "IDEMPOTENCY_CONFLICT");
      for (const key of entityKeys) {
        await transaction.put(`accounting:${key}`, { batch_key: batchKey, state: "claimed" });
      }
      return { disposition: "claimed", batch_key: batchKey, entity_keys: entityKeys };
    });
  }

  async completeAccounting(claim: AccountingLedgerClaim): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      for (const key of claim.entity_keys) {
        const entry = await transaction.get<{ batch_key: string; state: "claimed" | "written" }>(`accounting:${key}`);
        if (!entry || entry.batch_key !== claim.batch_key || entry.state !== "claimed") {
          deny("brainbase_proxy", "IDEMPOTENCY_CONFLICT");
        }
      }
      for (const key of claim.entity_keys) {
        await transaction.put(`accounting:${key}`, { batch_key: claim.batch_key, state: "written" });
      }
    });
  }

  async releaseAccounting(claim: AccountingLedgerClaim): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      for (const key of claim.entity_keys) {
        const storageKey = `accounting:${key}`;
        const entry = await transaction.get<{ batch_key: string; state: "claimed" | "written" }>(storageKey);
        if (entry?.batch_key === claim.batch_key && entry.state === "claimed") await transaction.delete(storageKey);
      }
    });
  }
}

export function createDurableTenantStateStore(storage: TenantStateStorage): IdempotencyStore {
  return new DurableTenantStateStore(storage);
}

export function createDurableTenantAccountingStore(storage: TenantStateStorage): TenantAccountingLedgerStore {
  const store = new DurableTenantStateStore(storage);
  return {
    claim: (input) => store.claimAccounting(input),
    complete: (claim) => store.completeAccounting(claim),
    release: (claim) => store.releaseAccounting(claim),
  };
}

interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface TenantRuntimeStateNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

async function callState<T>(stub: DurableObjectStubLike, operation: string, input: unknown): Promise<T> {
  const response = await stub.fetch(new Request(`https://tenant-runtime-state.internal/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
  const body = await response.json().catch(() => null) as { result?: T; error?: string } | null;
  if (!response.ok || body?.result === undefined) {
    throw new TenantBoundaryError("durable_object", body?.error ?? "UPSTREAM_UNAVAILABLE");
  }
  return body.result;
}

export function createDurableTenantStateClient(
  namespace: TenantRuntimeStateNamespace,
  tenantId: string,
): IdempotencyStore {
  const partitionKeys = new Map<string, string>();
  const stub = (partitionKey: string) => namespace.get(namespace.idFromName(`state:${partitionKey}`));
  return {
    claim: (input) => {
      if (input.tenant_id !== tenantId) deny("durable_object", "CROSS_TENANT_CANDIDATE");
      const partitionKey = createStoredClaim(input).partition_key;
      partitionKeys.set(input.key, partitionKey);
      return callState(stub(partitionKey), "idempotency/claim", input);
    },
    read: (key) => {
      const partitionKey = partitionKeys.get(key);
      if (!partitionKey) return undefined;
      return callState(stub(partitionKey), "idempotency/read", { key, partition_key: partitionKey });
    },
    release: (key, claimTenantId, inputPartitionKey) => {
      if (claimTenantId !== tenantId) deny("durable_object", "CROSS_TENANT_CANDIDATE");
      const partitionKey = inputPartitionKey ?? partitionKeys.get(key);
      if (!partitionKey) deny("durable_object", "IDEMPOTENCY_CLAIM_MISSING");
      return callState(stub(partitionKey), "idempotency/release",
        { key, tenant_id: claimTenantId, partition_key: partitionKey });
    },
    complete: (input) => {
      if (input.tenant_id !== tenantId) deny("durable_object", "CROSS_TENANT_CANDIDATE");
      const partitionKey = input.partition_key ?? partitionKeys.get(input.key);
      if (!partitionKey) deny("durable_object", "IDEMPOTENCY_CLAIM_MISSING");
      return callState(stub(partitionKey), "idempotency/complete", { ...input, partition_key: partitionKey });
    },
  };
}

export function createDurableTenantAccountingClient(
  namespace: TenantRuntimeStateNamespace,
  tenantContext: TenantContextEnvelope,
): TenantAccountingLedgerStore {
  const tenantId = tenantContext.tenant.tenant_id;
  const statePartitionKey = tenantPartitionKey({
    tenant_id: tenantId,
    resource_type: "usage",
    connection_id: tenantContext.workspace_connection.connection_id,
    workspace_id: tenantContext.workspace_connection.workspace_id,
    channel_id: tenantContext.slack.channel_id,
    thread_ts: tenantContext.slack.thread_ts ?? "",
    resource_id: tenantContext.correlation_id,
  });
  const stub = namespace.get(namespace.idFromName(`accounting:${statePartitionKey}`));
  return {
    claim: (input) => {
      if (input.tenant_context.tenant.tenant_id !== tenantId
        || input.tenant_context.workspace_connection.connection_id
          !== tenantContext.workspace_connection.connection_id
        || input.tenant_context.correlation_id !== tenantContext.correlation_id) {
        deny("durable_object", "CROSS_TENANT_CANDIDATE");
      }
      return callState(stub, "accounting/claim", input);
    },
    complete: (claim) => callState(stub, "accounting/complete", claim),
    release: (claim) => callState(stub, "accounting/release", claim),
  };
}

export class TenantRuntimeStateHandler {
  readonly #idempotency: DurableTenantStateStore;
  readonly #accounting: TenantAccountingLedgerStore;

  constructor(storage: TenantStateStorage) {
    this.#idempotency = new DurableTenantStateStore(storage);
    this.#accounting = createDurableTenantAccountingStore(storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.hostname !== "tenant-runtime-state.internal") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const input = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!input) return Response.json({ error: "SCHEMA_INVALID" }, { status: 400 });
    try {
      let result: unknown;
      if (url.pathname === "/idempotency/claim") {
        result = await this.#idempotency.claim(input as unknown as IdempotencyClaimInput);
      } else if (url.pathname === "/idempotency/read") {
        const partitionKey = String(input.partition_key ?? "");
        result = partitionKey
          ? await this.#idempotency.storageReadByPartition(partitionKey)
          : await this.#idempotency.read(String(input.key ?? ""));
      } else if (url.pathname === "/idempotency/release") {
        await this.#idempotency.release(String(input.key ?? ""), String(input.tenant_id ?? ""),
          String(input.partition_key ?? "") || undefined);
        result = null;
      } else if (url.pathname === "/idempotency/complete") {
        result = await this.#idempotency.complete(input as unknown as IdempotencyCompleteInput);
      } else if (url.pathname === "/accounting/claim") {
        result = await this.#accounting.claim(input as unknown as Parameters<TenantAccountingLedgerStore["claim"]>[0]);
      } else if (url.pathname === "/accounting/complete") {
        await this.#accounting.complete(input as unknown as AccountingLedgerClaim);
        result = null;
      } else if (url.pathname === "/accounting/release") {
        await this.#accounting.release(input as unknown as AccountingLedgerClaim);
        result = null;
      } else {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      return Response.json({ result });
    } catch (error) {
      const code = error instanceof TenantBoundaryError ? error.code : "UPSTREAM_UNAVAILABLE";
      return Response.json({ error: code }, { status: code === "UPSTREAM_UNAVAILABLE" ? 503 : 409 });
    }
  }
}
