import type {
  AccountingArtifact,
  AccountingLedgerClaim,
  AccountingLedgerResult,
  TenantAccountingLedgerStore,
} from "./accounting.js";
import type {
  IdempotencyClaim,
  IdempotencyClaimInput,
  IdempotencyCompleteInput,
  IdempotencyRenewInput,
  IdempotencyStore,
} from "./idempotency.js";
import {
  IDEMPOTENCY_RETENTION_MS,
  idempotencyLeaseUntil,
  isIdempotencyClaimLeaseExpired,
  prepareIdempotencyClaimInput,
  shouldReclaimIdempotencyClaim,
} from "./idempotency.js";
import { deny, TenantBoundaryError } from "./errors.js";
import { tenantPartitionKey } from "./isolation.js";
import type { TenantContextEnvelope } from "./contracts.js";
import {
  assertSameEffect,
  assertValidClaim,
  assertValidTransition,
  type ExternalEffectOutboxRecord,
  type ExternalEffectOutboxStore,
} from "./company-authority-external-effect-outbox.js";

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

function externalEffectStorageKey(tenantId: string, effectId: string): string {
  return `external-effect-outbox:${JSON.stringify([tenantId, effectId])}`;
}

const EXTERNAL_EFFECT_SCOPE_KEY = "external-effect-outbox:scope";

async function bindExternalEffectScope(
  storage: TenantStateStorage,
  scope: { tenant_id: string; effect_id: string },
): Promise<void> {
  await storage.transaction(async (transaction) => {
    const existing = await transaction.get<{ tenant_id: string; effect_id: string }>(EXTERNAL_EFFECT_SCOPE_KEY);
    if (existing && (existing.tenant_id !== scope.tenant_id || existing.effect_id !== scope.effect_id)) {
      deny("external_effect", "CROSS_TENANT_CANDIDATE");
    }
    if (!existing) await transaction.put(EXTERNAL_EFFECT_SCOPE_KEY, clone(scope));
  });
}

class DurableExternalEffectOutboxStore implements ExternalEffectOutboxStore {
  constructor(
    private readonly storage: TenantStateStorage,
    private readonly scope: { tenant_id: string; effect_id: string },
    private readonly now: () => number = Date.now,
  ) {}

  #assertScope(record: Pick<ExternalEffectOutboxRecord, "tenant_id" | "effect_id">): void {
    if (record.tenant_id !== this.scope.tenant_id || record.effect_id !== this.scope.effect_id) {
      deny("external_effect", "CROSS_TENANT_CANDIDATE");
    }
  }

  async begin(record: ExternalEffectOutboxRecord): Promise<{
    record: ExternalEffectOutboxRecord;
    created: boolean;
  }> {
    this.#assertScope(record);
    return this.storage.transaction(async (transaction) => {
      const key = externalEffectStorageKey(record.tenant_id, record.effect_id);
      const existing = await transaction.get<ExternalEffectOutboxRecord>(key);
      if (existing) {
        assertSameEffect(existing, record);
        return { record: clone(existing), created: false };
      }
      await transaction.put(key, clone(record));
      return { record: clone(record), created: true };
    });
  }

  async write(record: ExternalEffectOutboxRecord): Promise<void> {
    this.#assertScope(record);
    await this.storage.transaction(async (transaction) => {
      const key = externalEffectStorageKey(record.tenant_id, record.effect_id);
      const existing = await transaction.get<ExternalEffectOutboxRecord>(key);
      if (!existing) deny("external_effect", "EXTERNAL_EFFECT_OUTBOX_MISSING");
      assertSameEffect(existing, record);
      if (existing.state === "in_flight" && record.state !== "in_flight"
        && existing.claim_token !== record.claim_token) {
        deny("external_effect", "EXTERNAL_EFFECT_CLAIM_CONFLICT");
      }
      assertValidTransition(existing, record);
      await transaction.put(key, clone(record));
    });
  }

  async claim(record: ExternalEffectOutboxRecord): Promise<{
    record: ExternalEffectOutboxRecord;
    claimed: boolean;
  }> {
    this.#assertScope(record);
    return this.storage.transaction(async (transaction) => {
      const key = externalEffectStorageKey(record.tenant_id, record.effect_id);
      const existing = await transaction.get<ExternalEffectOutboxRecord>(key);
      if (!existing) deny("external_effect", "EXTERNAL_EFFECT_OUTBOX_MISSING");
      assertSameEffect(existing, record);
      const reclaimable = existing.state === "in_flight"
        && typeof existing.claim_expires_at === "number"
        && existing.claim_expires_at <= this.now();
      if (existing.state !== "pending" && !reclaimable) {
        return { record: clone(existing), claimed: false };
      }
      assertValidClaim(record);
      if (existing.state === "pending") assertValidTransition(existing, record);
      await transaction.put(key, clone(record));
      return { record: clone(record), claimed: true };
    });
  }

  async read(tenantId: string, effectId: string): Promise<ExternalEffectOutboxRecord | null> {
    this.#assertScope({ tenant_id: tenantId, effect_id: effectId });
    const record = await this.storage.get<ExternalEffectOutboxRecord>(
      externalEffectStorageKey(tenantId, effectId),
    );
    return record ? clone(record) : null;
  }
}

function createStoredClaim(input: IdempotencyClaimInput): IdempotencyClaim {
  const normalized = prepareIdempotencyClaimInput(input);
  return {
    ...clone(normalized),
    state: "claimed",
    claim_token: createClaimToken(),
    partition_key: tenantPartitionKey({
      tenant_id: normalized.tenant_id,
      resource_type: "idempotency",
      connection_id: normalized.connection_id,
      workspace_id: "",
      channel_id: "",
      thread_ts: "",
      resource_id: normalized.key,
    }),
  };
}

function createClaimToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `ict1_${btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
}

function assertCompletionWindow(input: IdempotencyCompleteInput): void {
  const updatedAt = Date.parse(input.updated_at);
  const retainedUntil = Date.parse(input.retained_until);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(retainedUntil)
    || retainedUntil - updatedAt < IDEMPOTENCY_RETENTION_MS) {
    deny("idempotency", "IDEMPOTENCY_RETENTION_INVALID");
  }
}

class DurableTenantStateStore implements IdempotencyStore {
  readonly #partitionKeys = new Map<string, string>();

  constructor(private readonly storage: TenantStateStorage) {}

  async claim(input: IdempotencyClaimInput): Promise<{ created: boolean; value: IdempotencyClaim }> {
    return this.storage.transaction(async (transaction) => {
      const normalized = prepareIdempotencyClaimInput(input);
      const stored = createStoredClaim(normalized);
      const key = idempotencyStorageKey(stored.partition_key);
      const existing = await transaction.get<IdempotencyClaim>(key);
      if (existing) {
        if (shouldReclaimIdempotencyClaim(existing, normalized)) {
          await transaction.put(key, stored);
          this.#partitionKeys.set(normalized.key, stored.partition_key);
          return { created: true, value: clone(stored) };
        }
        this.#partitionKeys.set(normalized.key, existing.partition_key);
        return { created: false, value: clone(existing) };
      }
      await transaction.put(key, stored);
      this.#partitionKeys.set(normalized.key, stored.partition_key);
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

  async release(key: string, tenantId: string, inputPartitionKey?: string, claimToken?: string): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const partitionKey = inputPartitionKey ?? this.#partitionKeys.get(key);
      if (!partitionKey) deny("idempotency", "IDEMPOTENCY_CLAIM_MISSING");
      const storageKey = idempotencyStorageKey(partitionKey);
      const current = await transaction.get<IdempotencyClaim>(storageKey);
      if (!current) return;
      if (current.tenant_id !== tenantId) deny("idempotency", "CROSS_TENANT_CANDIDATE");
      if (current.claim_token !== undefined
        && (current.scope === "queue_execution" || claimToken !== undefined)
        && current.claim_token !== claimToken) {
        deny("idempotency", "IDEMPOTENCY_CONFLICT", { key });
      }
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
      if (current.claim_token !== undefined
        && (current.scope === "queue_execution" || input.claim_token !== undefined)
        && current.claim_token !== input.claim_token) {
        deny("idempotency", "IDEMPOTENCY_CONFLICT", { key: input.key });
      }
      const currentUpdatedAt = Date.parse(current.updated_at);
      const updatedAt = Date.parse(input.updated_at);
      if (Number.isFinite(currentUpdatedAt) && Number.isFinite(updatedAt) && updatedAt < currentUpdatedAt) {
        deny("idempotency", "IDEMPOTENCY_TIMESTAMP_REGRESSION", { key: input.key });
      }
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

  async renew(input: IdempotencyRenewInput): Promise<IdempotencyClaim> {
    return this.storage.transaction(async (transaction) => {
      const partitionKey = input.partition_key ?? this.#partitionKeys.get(input.key);
      if (!partitionKey) deny("idempotency", "IDEMPOTENCY_CLAIM_MISSING");
      const storageKey = idempotencyStorageKey(partitionKey);
      const current = await transaction.get<IdempotencyClaim>(storageKey);
      if (!current) deny("idempotency", "IDEMPOTENCY_CLAIM_MISSING");
      if (current.tenant_id !== input.tenant_id) deny("idempotency", "CROSS_TENANT_CANDIDATE");
      if (current.partition_key !== partitionKey || current.scope !== "queue_execution"
        || current.state !== "claimed") {
        deny("idempotency", "IDEMPOTENCY_CONFLICT", { key: input.key });
      }
      if (current.claim_token !== input.claim_token) {
        deny("idempotency", "IDEMPOTENCY_CONFLICT", { key: input.key });
      }
      if (isIdempotencyClaimLeaseExpired(current, input.updated_at)) {
        deny("idempotency", "IDEMPOTENCY_CONFLICT", { key: input.key });
      }
      const currentUpdatedAt = Date.parse(current.updated_at);
      const updatedAt = Date.parse(input.updated_at);
      if (!Number.isFinite(updatedAt) || (Number.isFinite(currentUpdatedAt) && updatedAt < currentUpdatedAt)) {
        deny("idempotency", "IDEMPOTENCY_LEASE_INVALID", { key: input.key });
      }
      const renewed: IdempotencyClaim = {
        ...current,
        updated_at: input.updated_at,
        lease_until: idempotencyLeaseUntil(input.updated_at),
      };
      await transaction.put(storageKey, renewed);
      this.#partitionKeys.set(input.key, renewed.partition_key);
      return clone(renewed);
    });
  }

  async claimAccounting(input: {
    tenant_context: TenantContextEnvelope;
    usage_event_ids: readonly string[];
    receipt_id: string;
    payload_hash: string;
    artifact: AccountingArtifact;
    operation_result?: unknown;
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
    const outboxKey = entityKeys[entityKeys.length - 1];
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
        const pending = outboxKey ? await transaction.get<{
          batch_key: string;
          artifact: AccountingArtifact;
          operation_result?: unknown;
        }>(`accounting-outbox:${outboxKey}`) : undefined;
        if (!pending || pending.batch_key !== batchKey) deny("brainbase_proxy", "IDEMPOTENCY_CONFLICT");
        return { disposition: "claimed", batch_key: batchKey, entity_keys: entityKeys, outbox_key: outboxKey };
      }
      if (entries.some((entry) => entry !== undefined)) deny("brainbase_proxy", "IDEMPOTENCY_CONFLICT");
      if (!outboxKey) deny("brainbase_proxy", "IDEMPOTENCY_CONFLICT");
      for (const key of entityKeys) {
        await transaction.put(`accounting:${key}`, { batch_key: batchKey, state: "claimed" });
      }
      await transaction.put(`accounting-outbox:${outboxKey}`, {
        batch_key: batchKey,
        artifact: clone(input.artifact),
        ...(input.operation_result === undefined
          ? {}
          : { operation_result: clone(input.operation_result) }),
      });
      return { disposition: "claimed", batch_key: batchKey, entity_keys: entityKeys, outbox_key: outboxKey };
    });
  }

  async readPendingAccounting(input: {
    tenant_context: TenantContextEnvelope;
    receipt_id: string;
  }): Promise<AccountingArtifact | undefined> {
    const key = tenantPartitionKey({
      tenant_id: input.tenant_context.tenant.tenant_id,
      resource_type: "usage",
      connection_id: input.tenant_context.workspace_connection.connection_id,
      workspace_id: input.tenant_context.workspace_connection.workspace_id,
      channel_id: input.tenant_context.slack.channel_id,
      thread_ts: input.tenant_context.slack.thread_ts ?? "",
      resource_id: input.receipt_id,
    });
    const pending = await this.storage.get<{ batch_key: string; artifact: AccountingArtifact }>(
      `accounting-outbox:${key}`,
    );
    return pending ? clone(pending.artifact) : undefined;
  }

  async readPendingAccountingResult(input: {
    tenant_context: TenantContextEnvelope;
    receipt_id: string;
  }): Promise<unknown | undefined> {
    const key = tenantPartitionKey({
      tenant_id: input.tenant_context.tenant.tenant_id,
      resource_type: "usage",
      connection_id: input.tenant_context.workspace_connection.connection_id,
      workspace_id: input.tenant_context.workspace_connection.workspace_id,
      channel_id: input.tenant_context.slack.channel_id,
      thread_ts: input.tenant_context.slack.thread_ts ?? "",
      resource_id: input.receipt_id,
    });
    const pending = await this.storage.get<{ batch_key: string; operation_result?: unknown }>(
      `accounting-outbox:${key}`,
    );
    return pending?.operation_result === undefined ? undefined : clone(pending.operation_result);
  }

  async reserveAccountingTimestamp(input: {
    tenant_context: TenantContextEnvelope;
    receipt_id: string;
    proposed_at: string;
  }): Promise<string> {
    const key = tenantPartitionKey({
      tenant_id: input.tenant_context.tenant.tenant_id,
      resource_type: "usage",
      connection_id: input.tenant_context.workspace_connection.connection_id,
      workspace_id: input.tenant_context.workspace_connection.workspace_id,
      channel_id: input.tenant_context.slack.channel_id,
      thread_ts: input.tenant_context.slack.thread_ts ?? "",
      resource_id: input.receipt_id,
    });
    return this.storage.transaction(async (transaction) => {
      const storageKey = `accounting-timestamp:${key}`;
      const existing = await transaction.get<string>(storageKey);
      if (existing) return existing;
      await transaction.put(storageKey, input.proposed_at);
      return input.proposed_at;
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
      await transaction.delete(`accounting-outbox:${claim.outbox_key}`);
    });
  }

  async releaseAccounting(claim: AccountingLedgerClaim): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      for (const key of claim.entity_keys) {
        const storageKey = `accounting:${key}`;
        const entry = await transaction.get<{ batch_key: string; state: "claimed" | "written" }>(storageKey);
        if (entry?.batch_key === claim.batch_key && entry.state === "claimed") await transaction.delete(storageKey);
      }
      const pending = await transaction.get<{ batch_key: string }>(`accounting-outbox:${claim.outbox_key}`);
      if (pending?.batch_key === claim.batch_key) {
        await transaction.delete(`accounting-outbox:${claim.outbox_key}`);
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
    reserve_timestamp: (input) => store.reserveAccountingTimestamp(input),
    claim: (input) => store.claimAccounting(input),
    read_pending: (input) => store.readPendingAccounting(input),
    read_pending_result: (input) => store.readPendingAccountingResult(input),
    complete: (claim) => store.completeAccounting(claim),
    release: (claim) => store.releaseAccounting(claim),
  };
}

export function createDurableExternalEffectOutboxStore(
  storage: TenantStateStorage,
  scope: { tenant_id: string; effect_id: string },
  now: () => number = Date.now,
): ExternalEffectOutboxStore {
  return new DurableExternalEffectOutboxStore(storage, scope, now);
}

interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface TenantRuntimeStateNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

function externalEffectObjectName(scope: { tenant_id: string; effect_id: string }): string {
  return `external-effect:${JSON.stringify([scope.tenant_id, scope.effect_id])}`;
}

function assertExternalEffectClientScope(
  scope: { tenant_id: string; effect_id: string },
  candidate: Pick<ExternalEffectOutboxRecord, "tenant_id" | "effect_id">,
): void {
  if (candidate.tenant_id !== scope.tenant_id || candidate.effect_id !== scope.effect_id) {
    deny("durable_object", "CROSS_TENANT_CANDIDATE");
  }
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

async function callOptionalState<T>(
  stub: DurableObjectStubLike,
  operation: string,
  input: unknown,
): Promise<T | undefined> {
  const result = await callState<T | null>(stub, operation, input);
  return result === null ? undefined : result;
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
      return callOptionalState(stub(partitionKey), "idempotency/read", { key, partition_key: partitionKey });
    },
    release: (key, claimTenantId, inputPartitionKey, claimToken) => {
      if (claimTenantId !== tenantId) deny("durable_object", "CROSS_TENANT_CANDIDATE");
      const partitionKey = inputPartitionKey ?? partitionKeys.get(key);
      if (!partitionKey) deny("durable_object", "IDEMPOTENCY_CLAIM_MISSING");
      return callState(stub(partitionKey), "idempotency/release",
        { key, tenant_id: claimTenantId, partition_key: partitionKey, claim_token: claimToken });
    },
    complete: (input) => {
      if (input.tenant_id !== tenantId) deny("durable_object", "CROSS_TENANT_CANDIDATE");
      const partitionKey = input.partition_key ?? partitionKeys.get(input.key);
      if (!partitionKey) deny("durable_object", "IDEMPOTENCY_CLAIM_MISSING");
      return callState(stub(partitionKey), "idempotency/complete", { ...input, partition_key: partitionKey });
    },
    renew: (input) => {
      if (input.tenant_id !== tenantId) deny("durable_object", "CROSS_TENANT_CANDIDATE");
      const partitionKey = input.partition_key ?? partitionKeys.get(input.key);
      if (!partitionKey) deny("durable_object", "IDEMPOTENCY_CLAIM_MISSING");
      partitionKeys.set(input.key, partitionKey);
      return callState(stub(partitionKey), "idempotency/renew", { ...input, partition_key: partitionKey });
    },
  };
}

export function createDurableExternalEffectOutboxClient(
  namespace: TenantRuntimeStateNamespace,
  scope: { tenant_id: string; effect_id: string },
): ExternalEffectOutboxStore {
  const stub = namespace.get(namespace.idFromName(externalEffectObjectName(scope)));
  return {
    begin: async (record) => {
      assertExternalEffectClientScope(scope, record);
      return callState(stub, "external-effect/begin", record);
    },
    claim: async (record) => {
      assertExternalEffectClientScope(scope, record);
      return callState(stub, "external-effect/claim", record);
    },
    write: async (record) => {
      assertExternalEffectClientScope(scope, record);
      return callState(stub, "external-effect/write", record);
    },
    read: async (tenantId, effectId) => {
      assertExternalEffectClientScope(scope, { tenant_id: tenantId, effect_id: effectId });
      return callState(stub, "external-effect/read", { tenant_id: tenantId, effect_id: effectId });
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
    reserve_timestamp: (input) => {
      if (input.tenant_context.tenant.tenant_id !== tenantId
        || input.tenant_context.workspace_connection.connection_id
          !== tenantContext.workspace_connection.connection_id
        || input.tenant_context.correlation_id !== tenantContext.correlation_id) {
        deny("durable_object", "CROSS_TENANT_CANDIDATE");
      }
      return callState(stub, "accounting/reserve-timestamp", input);
    },
    claim: (input) => {
      if (input.tenant_context.tenant.tenant_id !== tenantId
        || input.tenant_context.workspace_connection.connection_id
          !== tenantContext.workspace_connection.connection_id
        || input.tenant_context.correlation_id !== tenantContext.correlation_id) {
        deny("durable_object", "CROSS_TENANT_CANDIDATE");
      }
      return callState(stub, "accounting/claim", input);
    },
    read_pending: (input) => {
      if (input.tenant_context.tenant.tenant_id !== tenantId
        || input.tenant_context.workspace_connection.connection_id
          !== tenantContext.workspace_connection.connection_id
        || input.tenant_context.correlation_id !== tenantContext.correlation_id) {
        deny("durable_object", "CROSS_TENANT_CANDIDATE");
      }
      return callOptionalState(stub, "accounting/read-pending", input);
    },
    read_pending_result: (input) => {
      if (input.tenant_context.tenant.tenant_id !== tenantId
        || input.tenant_context.workspace_connection.connection_id
          !== tenantContext.workspace_connection.connection_id
        || input.tenant_context.correlation_id !== tenantContext.correlation_id) {
        deny("durable_object", "CROSS_TENANT_CANDIDATE");
      }
      return callOptionalState(stub, "accounting/read-pending-result", input);
    },
    complete: (claim) => callState(stub, "accounting/complete", claim),
    release: (claim) => callState(stub, "accounting/release", claim),
  };
}

export class TenantRuntimeStateHandler {
  readonly #idempotency: DurableTenantStateStore;
  readonly #accounting: TenantAccountingLedgerStore;
  readonly #storage: TenantStateStorage;

  constructor(
    storage: TenantStateStorage,
    private readonly objectName?: string,
  ) {
    this.#storage = storage;
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
          String(input.partition_key ?? "") || undefined,
          typeof input.claim_token === "string" ? input.claim_token : undefined);
        result = null;
      } else if (url.pathname === "/idempotency/complete") {
        result = await this.#idempotency.complete(input as unknown as IdempotencyCompleteInput);
      } else if (url.pathname === "/idempotency/renew") {
        result = await this.#idempotency.renew(input as unknown as IdempotencyRenewInput);
      } else if (url.pathname === "/accounting/reserve-timestamp") {
        result = await this.#accounting.reserve_timestamp(
          input as unknown as Parameters<TenantAccountingLedgerStore["reserve_timestamp"]>[0],
        );
      } else if (url.pathname === "/accounting/claim") {
        result = await this.#accounting.claim(input as unknown as Parameters<TenantAccountingLedgerStore["claim"]>[0]);
      } else if (url.pathname === "/accounting/read-pending") {
        result = await this.#accounting.read_pending(
          input as unknown as Parameters<TenantAccountingLedgerStore["read_pending"]>[0],
        );
      } else if (url.pathname === "/accounting/read-pending-result") {
        result = await this.#accounting.read_pending_result(
          input as unknown as Parameters<TenantAccountingLedgerStore["read_pending_result"]>[0],
        );
      } else if (url.pathname === "/accounting/complete") {
        await this.#accounting.complete(input as unknown as AccountingLedgerClaim);
        result = null;
      } else if (url.pathname === "/accounting/release") {
        await this.#accounting.release(input as unknown as AccountingLedgerClaim);
        result = null;
      } else if (url.pathname.startsWith("/external-effect/")) {
        const operations = new Set([
          "/external-effect/begin",
          "/external-effect/claim",
          "/external-effect/write",
          "/external-effect/read",
        ]);
        if (!operations.has(url.pathname)) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }
        const candidate = input as unknown as ExternalEffectOutboxRecord;
        const scope = { tenant_id: candidate.tenant_id, effect_id: candidate.effect_id };
        if (typeof scope.tenant_id !== "string" || scope.tenant_id.length === 0
          || typeof scope.effect_id !== "string" || scope.effect_id.length === 0) {
          deny("external_effect", "EXTERNAL_EFFECT_CONTEXT_INVALID");
        }
        if (this.objectName !== externalEffectObjectName(scope)) {
          deny("external_effect", "CROSS_TENANT_CANDIDATE");
        }
        if (url.pathname !== "/external-effect/read") {
          const states = new Set(["pending", "in_flight", "succeeded", "failed_terminal", "unknown_requires_reconcile"]);
          if (typeof candidate.provider_key !== "string" || candidate.provider_key.length === 0
            || typeof candidate.payload_hash !== "string" || candidate.payload_hash.length === 0
            || !states.has(candidate.state)) {
            deny("external_effect", "EXTERNAL_EFFECT_CONTEXT_INVALID");
          }
        }
        if (url.pathname === "/external-effect/begin" && candidate.state !== "pending") {
          deny("external_effect", "EXTERNAL_EFFECT_STATE_CONFLICT");
        }
        if (url.pathname === "/external-effect/claim") {
          assertValidClaim(candidate);
          if ((candidate.claim_expires_at ?? 0) <= Date.now()) {
            deny("external_effect", "EXTERNAL_EFFECT_CLAIM_INVALID");
          }
        }
        if (url.pathname === "/external-effect/write") {
          if (candidate.state === "pending") deny("external_effect", "EXTERNAL_EFFECT_STATE_CONFLICT");
          if (candidate.state === "in_flight") assertValidClaim(candidate);
          if (candidate.state === "succeeded"
            && (typeof candidate.result_ref !== "string" || candidate.result_ref.length === 0)) {
            deny("external_effect", "EXTERNAL_EFFECT_CONTEXT_INVALID");
          }
          if (candidate.state === "failed_terminal"
            && (typeof candidate.failure_code !== "string" || candidate.failure_code.length === 0)) {
            deny("external_effect", "EXTERNAL_EFFECT_CONTEXT_INVALID");
          }
        }
        await bindExternalEffectScope(this.#storage, scope);
        const outbox = createDurableExternalEffectOutboxStore(this.#storage, scope);
        if (url.pathname === "/external-effect/begin") {
          result = await outbox.begin(candidate);
        } else if (url.pathname === "/external-effect/claim") {
          result = await outbox.claim(candidate);
        } else if (url.pathname === "/external-effect/write") {
          await outbox.write(candidate);
          result = null;
        } else if (url.pathname === "/external-effect/read") {
          result = await outbox.read(scope.tenant_id, scope.effect_id);
        }
      } else {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      return Response.json({ result: result ?? null });
    } catch (error) {
      const code = error instanceof TenantBoundaryError ? error.code : "UPSTREAM_UNAVAILABLE";
      return Response.json({ error: code }, { status: code === "UPSTREAM_UNAVAILABLE" ? 503 : 409 });
    }
  }
}
