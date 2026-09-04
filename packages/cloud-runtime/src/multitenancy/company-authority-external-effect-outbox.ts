import type { AccountingArtifact } from "./accounting.js";
import type { TenantContextEnvelope } from "./contracts.js";
import type { AcceptedCompanyAuthorityContext } from "./company-authority-runtime-adapter.js";
import { TenantBoundaryError } from "./errors.js";
import { jcsCanonicalize } from "./jcs.js";
import { assertSecretArtifactFree } from "./secret-guard.js";

export type ExternalEffectState =
  | "pending"
  | "in_flight"
  | "succeeded"
  | "failed_terminal"
  | "unknown_requires_reconcile";

/**
 * The immutable identity needed to recover a provider call without deriving a
 * new delivery target. This is deliberately a data record, not a Slack client
 * credential or an instruction to post.
 */
export interface ExternalEffectDeliveryIdentity {
  readonly provider: "slack";
  readonly workspace_id: string;
  readonly app_id: string;
  readonly channel_id: string;
  readonly thread_ts: string;
  readonly event_id: string;
  readonly delivery_id: string;
  readonly message_ts?: string;
  /** Observed provider identity, captured only after a send attempt. */
  readonly response_ts?: string;
  readonly body_hash?: string;
  readonly bot_id?: string;
  /** Durable Object name used by the runtime claim store. */
  readonly workspace_name?: string;
}

/**
 * Tenant-bound recovery material persisted before an external provider call.
 * The accounting context/artifact are canonical snapshots; they are never
 * used as a fresh authorization by the reconciler.
 */
export interface ExternalEffectRecoveryRecord {
  readonly runtime_event_id: string;
  readonly runtime_claim_token: string;
  readonly operation_id: string;
  readonly correlation_id: string;
  readonly accounting_context: TenantContextEnvelope;
  readonly accounting_artifact: AccountingArtifact;
  readonly delivery_identity: ExternalEffectDeliveryIdentity;
}

export interface ExternalEffectReconciliationJob {
  readonly schema_version: "1.0";
  readonly tenant_id: string;
  readonly effect_id: string;
  readonly provider_key: string;
  readonly payload_hash: string;
  readonly recovery: ExternalEffectRecoveryRecord;
  readonly enqueued_at: string;
  readonly settlement?: ExternalEffectReconciliationSettlement;
}

export type ExternalEffectReconciliationSettlementState =
  | "accounting_completed"
  | "runtime_claim_completed"
  | "settled";

export interface ExternalEffectReconciliationSettlement {
  readonly state: ExternalEffectReconciliationSettlementState;
  readonly result_ref: string;
  readonly updated_at: string;
}

export interface ExternalEffectOutboxRecord {
  readonly tenant_id: string;
  readonly effect_id: string;
  readonly provider_key: string;
  readonly payload_hash: string;
  readonly state: ExternalEffectState;
  readonly claim_token?: string;
  /** Observation deadline only; expiry never authorizes an automatic provider resend. */
  readonly claim_expires_at?: number;
  readonly result_ref?: string;
  readonly failure_code?: string;
  /** Immutable recovery material for unknown provider outcomes. */
  readonly recovery?: ExternalEffectRecoveryRecord;
}

export interface ExternalEffectOutboxStore {
  begin(record: ExternalEffectOutboxRecord): Promise<{
    record: ExternalEffectOutboxRecord;
    created: boolean;
  }>;
  claim(record: ExternalEffectOutboxRecord): Promise<{
    record: ExternalEffectOutboxRecord;
    claimed: boolean;
  }>;
  write(record: ExternalEffectOutboxRecord): Promise<void>;
  read(tenantId: string, effectId: string): Promise<ExternalEffectOutboxRecord | null>;
}

/** Internal durable queue boundary. It has no provider-send operation. */
export interface ExternalEffectReconciliationQueue {
  enqueue(job: ExternalEffectReconciliationJob): Promise<{
    job: ExternalEffectReconciliationJob;
    created: boolean;
  }>;
  read(tenantId: string, effectId: string): Promise<ExternalEffectReconciliationJob | null>;
  /** Monotonic durable settlement marker; never sends to a provider. */
  update?(job: ExternalEffectReconciliationJob): Promise<ExternalEffectReconciliationJob>;
}

export class ExternalEffectOutboxMemoryStore implements ExternalEffectOutboxStore {
  readonly #records = new Map<string, ExternalEffectOutboxRecord>();

  #key(tenantId: string, effectId: string): string {
    return JSON.stringify([tenantId, effectId]);
  }

  async begin(record: ExternalEffectOutboxRecord): Promise<{
    record: ExternalEffectOutboxRecord;
    created: boolean;
  }> {
    const key = this.#key(record.tenant_id, record.effect_id);
    const existing = this.#records.get(key);
    if (existing) {
      assertSameEffect(existing, record);
      return { record: structuredClone(existing), created: false };
    }
    this.#records.set(key, structuredClone(record));
    return { record: structuredClone(record), created: true };
  }

  async write(record: ExternalEffectOutboxRecord): Promise<void> {
    const key = this.#key(record.tenant_id, record.effect_id);
    const existing = this.#records.get(key);
    if (!existing) throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_OUTBOX_MISSING");
    assertSameEffect(existing, record);
    assertClaimTokenOwner(existing, record);
    assertValidTransition(existing, record);
    this.#records.set(key, structuredClone(record));
  }

  async claim(record: ExternalEffectOutboxRecord): Promise<{
    record: ExternalEffectOutboxRecord;
    claimed: boolean;
  }> {
    const key = this.#key(record.tenant_id, record.effect_id);
    const existing = this.#records.get(key);
    if (!existing) throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_OUTBOX_MISSING");
    assertSameEffect(existing, record);
    if (existing.state !== "pending") {
      return { record: structuredClone(existing), claimed: false };
    }
    assertValidClaim(record);
    assertValidTransition(existing, record);
    this.#records.set(key, structuredClone(record));
    return { record: structuredClone(record), claimed: true };
  }

  async read(tenantId: string, effectId: string): Promise<ExternalEffectOutboxRecord | null> {
    const record = this.#records.get(this.#key(tenantId, effectId));
    return record ? structuredClone(record) : null;
  }
}

function reconciliationKey(tenantId: string, effectId: string): string {
  return JSON.stringify([tenantId, effectId]);
}

function assertNonEmpty(value: unknown, code = "EXTERNAL_EFFECT_CONTEXT_INVALID"): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TenantBoundaryError("external_effect", code);
  }
}

function assertSignedTenantContext(context: TenantContextEnvelope): void {
  if (context.integrity?.method !== "jws_detached"
    || context.integrity.algorithm !== "EdDSA"
    || typeof context.integrity.key_id !== "string" || context.integrity.key_id.length === 0
    || typeof context.integrity.value !== "string" || context.integrity.value.length === 0) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_CONTEXT_INVALID");
  }
}

function assertRecoveryIdentity(
  tenantId: string,
  effectId: string,
  recovery: ExternalEffectRecoveryRecord,
  acceptedTenantContext?: unknown,
): void {
  assertNonEmpty(recovery.runtime_event_id);
  assertNonEmpty(recovery.runtime_claim_token);
  assertNonEmpty(recovery.operation_id);
  assertNonEmpty(recovery.correlation_id);
  assertSignedTenantContext(recovery.accounting_context);
  if (!recovery.accounting_artifact || typeof recovery.accounting_artifact !== "object"
    || !Array.isArray(recovery.accounting_artifact.usage_events)
    || !recovery.accounting_artifact.receipt
    || typeof recovery.accounting_artifact.partition_key !== "string"
    || recovery.accounting_artifact.partition_key.length === 0) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_CONTEXT_INVALID");
  }
  assertSecretArtifactFree(structuredClone(recovery.accounting_artifact));
  const context = recovery.accounting_context;
  if (context.tenant.tenant_id !== tenantId
    || context.idempotency_key !== effectId
    || context.operation_id !== recovery.operation_id
    || context.correlation_id !== recovery.correlation_id) {
    throw new TenantBoundaryError("external_effect", "CROSS_TENANT_CANDIDATE");
  }
  if (acceptedTenantContext !== undefined
    && jcsCanonicalize(acceptedTenantContext) !== jcsCanonicalize(context)) {
    throw new TenantBoundaryError("external_effect", "CROSS_TENANT_CANDIDATE");
  }
  const delivery = recovery.delivery_identity;
  if (!delivery || delivery.provider !== "slack"
    || delivery.workspace_id !== context.workspace_connection.workspace_id
    || delivery.app_id !== context.workspace_connection.app_id
    || delivery.channel_id !== context.slack.channel_id
    || delivery.thread_ts !== context.slack.thread_ts
    || delivery.event_id !== context.slack.event_id
    || delivery.delivery_id !== recovery.runtime_event_id) {
    throw new TenantBoundaryError("external_effect", "CROSS_TENANT_CANDIDATE");
  }
  const receipt = recovery.accounting_artifact.receipt;
  if (receipt.tenant_id !== tenantId
    || receipt.connection_id !== context.workspace_connection.connection_id
    || receipt.connection_revision !== context.workspace_connection.connection_revision
    || receipt.contract_revision !== context.contract_revision
    || receipt.deployment_id !== context.placement.deployment_id
    || receipt.correlation_id !== recovery.correlation_id
    || receipt.actor_principal_id !== context.actor.principal_id
    || !receipt.operation_ids.includes(recovery.operation_id)
    || !receipt.idempotency_keys.includes(effectId)
    || !context.authorization.project_ids.includes(receipt.project_id)
    || (receipt.reply.state !== "delivered" && receipt.reply.state !== "unknown")) {
    throw new TenantBoundaryError("external_effect", "CROSS_TENANT_CANDIDATE");
  }
  if (!recovery.accounting_artifact.usage_events.length
    || recovery.accounting_artifact.usage_events.some((event) => event.tenant_id !== tenantId
      || event.connection_id !== context.workspace_connection.connection_id
      || event.connection_revision !== context.workspace_connection.connection_revision
      || event.contract_revision !== context.contract_revision
      || event.deployment_id !== context.placement.deployment_id
      || event.correlation_id !== recovery.correlation_id
      || event.operation_id !== recovery.operation_id
      || event.idempotency_key !== effectId)) {
    throw new TenantBoundaryError("external_effect", "CROSS_TENANT_CANDIDATE");
  }
}

export function assertValidExternalEffectRecovery(
  record: Pick<ExternalEffectOutboxRecord, "tenant_id" | "effect_id"> & {
    recovery?: ExternalEffectRecoveryRecord;
  },
  acceptedTenantContext?: unknown,
): void {
  if (!record.recovery) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_RECOVERY_MISSING");
  }
  assertRecoveryIdentity(record.tenant_id, record.effect_id, record.recovery, acceptedTenantContext);
}

export function assertValidExternalEffectReconciliationJob(
  job: ExternalEffectReconciliationJob,
): void {
  if (job.schema_version !== "1.0"
    || typeof job.tenant_id !== "string" || job.tenant_id.length === 0
    || typeof job.effect_id !== "string" || job.effect_id.length === 0
    || typeof job.provider_key !== "string" || job.provider_key.length === 0
    || typeof job.payload_hash !== "string" || job.payload_hash.length === 0
    || typeof job.enqueued_at !== "string" || !Number.isFinite(Date.parse(job.enqueued_at))) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_CONTEXT_INVALID");
  }
  if (job.settlement !== undefined
    && (!(["accounting_completed", "runtime_claim_completed", "settled"] as const)
      .includes(job.settlement.state)
      || typeof job.settlement.result_ref !== "string" || job.settlement.result_ref.length === 0
      || typeof job.settlement.updated_at !== "string"
      || !Number.isFinite(Date.parse(job.settlement.updated_at)))) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_CONTEXT_INVALID");
  }
  assertValidExternalEffectRecovery(job);
}

function assertSameReconciliationJobIdentity(
  existing: ExternalEffectReconciliationJob,
  candidate: ExternalEffectReconciliationJob,
): void {
  if (existing.schema_version !== candidate.schema_version
    || existing.tenant_id !== candidate.tenant_id
    || existing.effect_id !== candidate.effect_id
    || existing.provider_key !== candidate.provider_key
    || existing.payload_hash !== candidate.payload_hash
    || jcsCanonicalize(existing.recovery) !== jcsCanonicalize(candidate.recovery)) {
    throw new TenantBoundaryError("external_effect", "IDEMPOTENCY_CONFLICT");
  }
}

const settlementRank: Record<ExternalEffectReconciliationSettlementState, number> = {
  accounting_completed: 1,
  runtime_claim_completed: 2,
  settled: 3,
};

export function assertValidReconciliationSettlementTransition(
  existing: ExternalEffectReconciliationJob,
  candidate: ExternalEffectReconciliationJob,
): void {
  assertSameReconciliationJobIdentity(existing, candidate);
  if (!candidate.settlement) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_CONTEXT_INVALID");
  }
  const current = existing.settlement;
  if (!current) return;
  if (current.result_ref !== candidate.settlement.result_ref) {
    throw new TenantBoundaryError("external_effect", "IDEMPOTENCY_CONFLICT");
  }
  if (settlementRank[candidate.settlement.state] < settlementRank[current.state]) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_STATE_CONFLICT");
  }
}

export class ExternalEffectReconciliationMemoryQueue implements ExternalEffectReconciliationQueue {
  readonly #jobs = new Map<string, ExternalEffectReconciliationJob>();

  async enqueue(job: ExternalEffectReconciliationJob): Promise<{
    job: ExternalEffectReconciliationJob;
    created: boolean;
  }> {
    assertValidExternalEffectReconciliationJob(job);
    const key = reconciliationKey(job.tenant_id, job.effect_id);
    const existing = this.#jobs.get(key);
    if (existing) {
      assertSameReconciliationJobIdentity(existing, job);
      return { job: structuredClone(existing), created: false };
    }
    this.#jobs.set(key, structuredClone(job));
    return { job: structuredClone(job), created: true };
  }

  async read(tenantId: string, effectId: string): Promise<ExternalEffectReconciliationJob | null> {
    const job = this.#jobs.get(reconciliationKey(tenantId, effectId));
    return job ? structuredClone(job) : null;
  }

  async update(job: ExternalEffectReconciliationJob): Promise<ExternalEffectReconciliationJob> {
    assertValidExternalEffectReconciliationJob(job);
    const key = reconciliationKey(job.tenant_id, job.effect_id);
    const existing = this.#jobs.get(key);
    if (!existing) {
      throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_RECONCILIATION_MISSING");
    }
    assertValidReconciliationSettlementTransition(existing, job);
    if (existing.settlement
      && settlementRank[existing.settlement.state] >= settlementRank[job.settlement!.state]) {
      return structuredClone(existing);
    }
    this.#jobs.set(key, structuredClone(job));
    return structuredClone(job);
  }
}

export function assertClaimTokenOwner(
  existing: ExternalEffectOutboxRecord,
  candidate: ExternalEffectOutboxRecord,
): void {
  if ((existing.state === "in_flight" || existing.state === "unknown_requires_reconcile")
    && existing.claim_token !== candidate.claim_token) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_CLAIM_CONFLICT");
  }
}

export function assertValidClaim(record: ExternalEffectOutboxRecord): void {
  if (record.state !== "in_flight"
    || typeof record.claim_token !== "string" || record.claim_token.length === 0
    || typeof record.claim_expires_at !== "number" || !Number.isFinite(record.claim_expires_at)) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_CLAIM_INVALID");
  }
}

export function assertValidTransition(
  existing: ExternalEffectOutboxRecord,
  candidate: ExternalEffectOutboxRecord,
): void {
  const allowed = existing.state === "pending"
    ? new Set<ExternalEffectState>(["pending", "in_flight"])
    : existing.state === "in_flight"
      ? new Set<ExternalEffectState>(["in_flight", "succeeded", "failed_terminal", "unknown_requires_reconcile"])
      : existing.state === "unknown_requires_reconcile"
        ? new Set<ExternalEffectState>(["unknown_requires_reconcile", "succeeded"])
        : new Set<ExternalEffectState>([existing.state]);
  if (!allowed.has(candidate.state)) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_STATE_CONFLICT", undefined, {
      effect_id: candidate.effect_id,
      current_state: existing.state,
      requested_state: candidate.state,
    });
  }
  if (existing.state === candidate.state
    && (existing.result_ref !== candidate.result_ref || existing.failure_code !== candidate.failure_code)) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_STATE_CONFLICT", undefined, {
      effect_id: candidate.effect_id,
    });
  }
}

export function assertSameEffect(
  existing: ExternalEffectOutboxRecord,
  candidate: ExternalEffectOutboxRecord,
): void {
  if (existing.provider_key !== candidate.provider_key
    || existing.payload_hash !== candidate.payload_hash
    || existing.tenant_id !== candidate.tenant_id) {
    throw new TenantBoundaryError("external_effect", "IDEMPOTENCY_CONFLICT", undefined, {
      effect_id: candidate.effect_id,
    });
  }
  if ((existing.recovery !== undefined && candidate.recovery === undefined)
    || (existing.recovery !== undefined && candidate.recovery !== undefined
      && jcsCanonicalize(existing.recovery) !== jcsCanonicalize(candidate.recovery))) {
    throw new TenantBoundaryError("external_effect", "IDEMPOTENCY_CONFLICT", undefined, {
      effect_id: candidate.effect_id,
      reason: "external_effect_recovery_conflict",
    });
  }
}

export type ExternalEffectProviderResult =
  | {
    readonly applied: true;
    readonly response_observed: true;
    readonly result_ref: string;
  }
  | {
    readonly applied: true;
    readonly response_observed: false;
  }
  | {
    readonly applied: false;
    readonly response_observed: true;
    readonly failure_code: string;
  };

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(jcsCanonicalize(value)),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function effectIdentity(context: AcceptedCompanyAuthorityContext): { effect_id: string; tenant_id: string } {
  const tenantContext = context.tenant_context as {
    idempotency_key?: unknown;
    tenant?: { tenant_id?: unknown };
  };
  if (typeof tenantContext.idempotency_key !== "string" || tenantContext.idempotency_key.length === 0) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_CONTEXT_INVALID");
  }
  if (typeof tenantContext.tenant?.tenant_id !== "string" || tenantContext.tenant.tenant_id.length === 0) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_CONTEXT_INVALID");
  }
  return { effect_id: tenantContext.idempotency_key, tenant_id: tenantContext.tenant.tenant_id };
}

/**
 * Persists an external effect before calling its provider. Once a provider call
 * starts, an exception or an unobserved response is ambiguous and must be
 * reconciled by provider_key; it is never converted into a blind Queue retry,
 * even after the claim observation deadline has elapsed.
 */
export async function processCompanyAuthorityExternalEffect<T>(input: {
  readonly context: AcceptedCompanyAuthorityContext;
  readonly payload: T;
  readonly outbox: ExternalEffectOutboxStore;
  readonly recovery?: ExternalEffectRecoveryRecord;
  readonly reconciliation_queue?: ExternalEffectReconciliationQueue;
  provider_send(input: {
    readonly provider_key: string;
    readonly payload: T;
    readonly capture_recovery?: (recovery: ExternalEffectRecoveryRecord) => Promise<void>;
  }): Promise<ExternalEffectProviderResult>;
  readonly claim_lease_ms?: number;
  readonly now?: () => number;
  readonly create_claim_token?: () => string;
}): Promise<ExternalEffectOutboxRecord> {
  const { effect_id, tenant_id } = effectIdentity(input.context);
  if (input.recovery !== undefined) {
    assertValidExternalEffectRecovery(
      { tenant_id, effect_id, recovery: input.recovery },
      input.context.tenant_context,
    );
  }
  let recovery = input.recovery === undefined ? undefined : structuredClone(input.recovery);
  const payload_hash = await sha256(input.payload);
  const provider_key = await sha256({ tenant_id, effect_id, payload_hash });
  const pending: ExternalEffectOutboxRecord = {
    tenant_id,
    effect_id,
    provider_key,
    payload_hash,
    state: "pending",
    ...(recovery === undefined ? {} : { recovery: structuredClone(recovery) }),
  };
  await input.outbox.begin(pending);
  const now = input.now ?? Date.now;
  const claimLeaseMs = input.claim_lease_ms ?? 60_000;
  if (!Number.isFinite(claimLeaseMs) || claimLeaseMs <= 0) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_CLAIM_INVALID");
  }
  const inFlight: ExternalEffectOutboxRecord = {
    ...pending,
    state: "in_flight",
    claim_token: (input.create_claim_token ?? (() => crypto.randomUUID()))(),
    claim_expires_at: now() + claimLeaseMs,
  };
  let claimed: Awaited<ReturnType<ExternalEffectOutboxStore["claim"]>>;
  try {
    claimed = await input.outbox.claim(inFlight);
  } catch (claimError) {
    const observed = await input.outbox.read(tenant_id, effect_id).catch(() => null);
    if (observed?.state === "in_flight" && observed.claim_token === inFlight.claim_token) {
      claimed = { record: observed, claimed: true };
    } else {
      throw claimError;
    }
  }
  if (!claimed.claimed) {
    if (claimed.record.state === "in_flight") {
      throw new TenantBoundaryError("external_effect", "UPSTREAM_UNAVAILABLE", undefined, {
        effect_id,
        reason: "external_effect_claim_active",
      });
    }
    return claimed.record;
  }

  let result: ExternalEffectProviderResult;
  const captureRecovery = input.reconciliation_queue === undefined
    ? undefined
    : async (candidate: ExternalEffectRecoveryRecord): Promise<void> => {
      assertValidExternalEffectRecovery(
        { tenant_id, effect_id, recovery: candidate },
        input.context.tenant_context,
      );
      if (recovery !== undefined && jcsCanonicalize(recovery) !== jcsCanonicalize(candidate)) {
        throw new TenantBoundaryError("external_effect", "IDEMPOTENCY_CONFLICT");
      }
      recovery = structuredClone(candidate);
    };
  try {
    result = await input.provider_send({
      provider_key,
      payload: structuredClone(input.payload),
      ...(captureRecovery === undefined ? {} : { capture_recovery: captureRecovery }),
    });
  } catch {
    const unknown = {
      ...inFlight,
      state: "unknown_requires_reconcile" as const,
      ...(recovery === undefined ? {} : { recovery: structuredClone(recovery) }),
    };
    try {
      await input.outbox.write(unknown);
    } catch {
      return inFlight;
    }
    // The durable unknown marker is the ACK boundary. A queue outage must not
    // turn an already-started provider call into a Queue retry (and therefore a
    // possible duplicate send); a later scanner can enqueue from the outbox.
    try {
      await enqueueReconciliation(input.reconciliation_queue, unknown, input.now);
    } catch {
      // Keep the sticky unknown record even when queue persistence is degraded.
    }
    return unknown;
  }

  const completed: ExternalEffectOutboxRecord = result.applied
    ? result.response_observed
      ? {
        ...inFlight,
        state: "succeeded",
        result_ref: result.result_ref,
        ...(recovery === undefined ? {} : { recovery: structuredClone(recovery) }),
      }
      : {
        ...inFlight,
        state: "unknown_requires_reconcile",
        ...(recovery === undefined ? {} : { recovery: structuredClone(recovery) }),
      }
    : { ...inFlight, state: "failed_terminal", failure_code: result.failure_code };
  try {
    await input.outbox.write(completed);
    if (completed.state === "unknown_requires_reconcile") {
      try {
        await enqueueReconciliation(input.reconciliation_queue, completed, input.now);
      } catch {
        // The outbox is durable; reconciliation can be re-enqueued later.
      }
    }
    return completed;
  } catch {
    // The provider has already been invoked. Preserve the durable in_flight
    // marker and ACK this delivery; a reconciler must resolve it by provider_key.
    try {
      await enqueueReconciliation(input.reconciliation_queue, {
        ...inFlight,
        ...(recovery === undefined ? {} : { recovery: structuredClone(recovery) }),
      }, input.now);
    } catch {
      // Do not surface queue failure after provider invocation.
    }
    return inFlight;
  }
}

async function enqueueReconciliation(
  queue: ExternalEffectReconciliationQueue | undefined,
  record: ExternalEffectOutboxRecord,
  now: (() => number) | undefined,
): Promise<void> {
  if (!queue || !record.recovery) return;
  await queue.enqueue({
    schema_version: "1.0",
    tenant_id: record.tenant_id,
    effect_id: record.effect_id,
    provider_key: record.provider_key,
    payload_hash: record.payload_hash,
    recovery: structuredClone(record.recovery),
    enqueued_at: new Date((now ?? Date.now)()).toISOString(),
  });
}

export async function reconcileCompanyAuthorityExternalEffect(input: {
  readonly tenant_id: string;
  readonly effect_id: string;
  readonly outbox: ExternalEffectOutboxStore;
  provider_reconcile(input: {
    readonly provider_key: string;
  }): Promise<{ readonly state: "succeeded"; readonly result_ref: string } | { readonly state: "unknown" }>;
}): Promise<ExternalEffectOutboxRecord | null> {
  const current = await input.outbox.read(input.tenant_id, input.effect_id);
  if (!current
    || (current.state !== "unknown_requires_reconcile" && current.state !== "in_flight")) return current;
  let reconciliation: { readonly state: "succeeded"; readonly result_ref: string } | { readonly state: "unknown" };
  try {
    reconciliation = await input.provider_reconcile({ provider_key: current.provider_key });
  } catch {
    return current;
  }
  if (reconciliation.state === "unknown") return current;
  const succeeded: ExternalEffectOutboxRecord = {
    ...current,
    state: "succeeded",
    result_ref: reconciliation.result_ref,
  };
  try {
    await input.outbox.write(succeeded);
    return succeeded;
  } catch {
    return current;
  }
}

/**
 * Reconcile one internally queued effect. The queue job and the durable
 * outbox record must agree byte-for-byte on every recovery identity before a
 * provider readback is attempted. There is intentionally no provider-send
 * callback in this contract.
 *
 * The settlement callback is mandatory because the existing accounting ledger
 * and runtime claim stores expose separate completion transactions. Until the
 * caller confirms that both have been completed idempotently, the outbox
 * remains `unknown_requires_reconcile` and is safe to retry.
 */
export async function reconcileCompanyAuthorityExternalEffectFromQueue(input: {
  readonly job: ExternalEffectReconciliationJob;
  readonly outbox: ExternalEffectOutboxStore;
  readonly reconciliation_queue?: ExternalEffectReconciliationQueue;
  readonly now?: () => number;
  readonly verify_context: (context: TenantContextEnvelope) => Promise<void>;
  readonly provider_reconcile: (input: {
    readonly provider_key: string;
  }) => Promise<{ readonly state: "succeeded"; readonly result_ref: string } | { readonly state: "unknown" }>;
  readonly settle_confirmed: (input: {
    readonly record: ExternalEffectOutboxRecord;
    readonly result_ref: string;
    readonly recovery: ExternalEffectRecoveryRecord;
    /** Optional durable stage marker used by the production compensating state machine. */
    readonly mark_stage?: (stage: ExternalEffectReconciliationSettlementState) => Promise<void>;
    readonly settlement_state?: ExternalEffectReconciliationSettlementState;
  }) => Promise<void>;
}): Promise<ExternalEffectOutboxRecord | null> {
  const job = input.job;
  assertValidExternalEffectReconciliationJob(job);
  const current = await input.outbox.read(job.tenant_id, job.effect_id);
  if (!current) {
    throw new TenantBoundaryError("external_effect", "EXTERNAL_EFFECT_OUTBOX_MISSING");
  }
  if (current.provider_key !== job.provider_key || current.payload_hash !== job.payload_hash
    || !current.recovery
    || jcsCanonicalize(current.recovery) !== jcsCanonicalize(job.recovery)) {
    throw new TenantBoundaryError("external_effect", "IDEMPOTENCY_CONFLICT");
  }
  if (current.state !== "unknown_requires_reconcile" && current.state !== "in_flight") return current;

  // A queue ACK or an outbox write may have failed after both completion
  // boundaries were durably confirmed. The settled marker is itself evidence
  // of the prior provider readback and lets us finish the outbox without a
  // second provider call.
  if (job.settlement?.state === "settled") {
    const succeeded: ExternalEffectOutboxRecord = {
      ...current,
      state: "succeeded",
      result_ref: job.settlement.result_ref,
    };
    try {
      await input.outbox.write(succeeded);
      return succeeded;
    } catch {
      return current;
    }
  }

  // The signed context is revalidated by the caller's authoritative verifier;
  // the persisted context itself is never treated as a fresh authorization.
  await input.verify_context(job.recovery.accounting_context);
  let reconciliation: Awaited<ReturnType<typeof input.provider_reconcile>>;
  try {
    reconciliation = await input.provider_reconcile({ provider_key: current.provider_key });
  } catch {
    return current;
  }
  if (reconciliation.state === "unknown") return current;
  if (typeof reconciliation.result_ref !== "string" || reconciliation.result_ref.length === 0) {
    return current;
  }

  const markStage = input.reconciliation_queue?.update === undefined
    ? undefined
    : async (stage: ExternalEffectReconciliationSettlementState): Promise<void> => {
      await input.reconciliation_queue!.update!({
        ...job,
        settlement: {
          state: stage,
          result_ref: reconciliation.result_ref,
          updated_at: new Date((input.now ?? Date.now)()).toISOString(),
        },
      });
    };
  try {
    await input.settle_confirmed({
      record: structuredClone(current),
      result_ref: reconciliation.result_ref,
      recovery: structuredClone(current.recovery),
      ...(markStage === undefined ? {} : { mark_stage: markStage }),
      ...(job.settlement?.state === undefined ? {} : { settlement_state: job.settlement.state }),
    });
    if (markStage !== undefined) await markStage("settled");
  } catch {
    // Keep the sticky unknown state until accounting and runtime claim
    // settlement is confirmed. Retrying this callback must be idempotent.
    return current;
  }
  const succeeded: ExternalEffectOutboxRecord = {
    ...current,
    state: "succeeded",
    result_ref: reconciliation.result_ref,
  };
  try {
    await input.outbox.write(succeeded);
    return succeeded;
  } catch {
    return current;
  }
}
