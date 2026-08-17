import type {
  CollectionState,
  ExpectedTenantScope,
  OperationOutcome,
  QuotaDecision,
  TenantContextEnvelope,
} from "./contracts.js";
import {
  CanonicalContractError,
  validateCanonicalOperationReceipt,
  validateCanonicalQuotaDecision,
  validateCanonicalUsageEvent,
} from "./canonical-consumer.js";
import { deny, TenantBoundaryError } from "./errors.js";
import { assertCanonicalSharedId } from "./ids.js";
import { tenantPartitionKey } from "./isolation.js";
import type { TenantRuntimeBoundaryVerifier } from "./runtime-boundaries.js";
import { assertSecretArtifactFree } from "./secret-guard.js";

export interface UsageEventInput {
  usage_event_id: string;
  protocol_version: string;
  tenant_id: string;
  connection_id: string;
  connection_revision: string;
  contract_revision: string;
  deployment_id: string;
  correlation_id: string;
  operation_id: string;
  idempotency_key: string;
  kind: string;
  quantity: number | null;
  unit: string;
  outcome: OperationOutcome;
  collection_state: CollectionState;
  failure_code?: string | null;
  observed_at: string;
  unknown_fields?: string[];
}

export interface UsageEvent extends UsageEventInput {
  message_type: "usage_event";
  failure_code: string | null;
  unknown_fields: string[];
}

export function createUsageEvent(input: UsageEventInput): UsageEvent {
  assertCanonicalSharedId(input.usage_event_id, "usage_", "usage");
  if (input.collection_state === "not_collected" && input.quantity !== null) {
    deny("usage", "USAGE_COLLECTION_INVALID");
  }
  if (input.collection_state === "collected" && input.quantity === null) {
    deny("usage", "USAGE_COLLECTION_INVALID");
  }
  if (input.collection_state === "partial" && input.quantity === null && !(input.unknown_fields?.length)) {
    deny("usage", "USAGE_COLLECTION_INVALID");
  }
  if (input.quantity !== null && (!Number.isFinite(input.quantity) || input.quantity < 0)) {
    deny("usage", "USAGE_COLLECTION_INVALID");
  }
  const usage: UsageEvent = {
    message_type: "usage_event",
    ...structuredClone(input),
    failure_code: input.failure_code ?? null,
    unknown_fields: structuredClone(input.unknown_fields ?? []),
  };
  try {
    validateCanonicalUsageEvent(usage);
  } catch (error) {
    if (error instanceof CanonicalContractError) deny("usage", error.code, error.details);
    throw error;
  }
  return usage;
}

export interface OperationReceiptInput {
  receipt_id: string;
  protocol_version: string;
  tenant_id: string;
  connection_id: string;
  connection_revision: string;
  contract_revision: string;
  deployment_id: string;
  correlation_id: string;
  operation_ids: string[];
  idempotency_keys: string[];
  actor_principal_id: string;
  project_id: string;
  capability_id: string;
  quota_decision: QuotaDecision["decision"];
  credential_mode: string;
  collection_state: CollectionState;
  outcome: OperationOutcome;
  failure_code?: string | null;
  usage_event_ids: string[];
  reply: {
    state: "not_attempted" | "delivered" | "failed" | "unknown";
    reply_count: 0 | 1;
    legacy_reply_count: 0;
    slack_reply_ts?: string;
  };
  completed_at: string;
}

export function createOperationReceipt(input: OperationReceiptInput): OperationReceipt {
  assertCanonicalSharedId(input.receipt_id, "receipt_", "receipt");
  if (input.operation_ids.length === 0 || input.idempotency_keys.length === 0) deny("receipt", "RECEIPT_INVALID");
  const receipt: OperationReceipt = {
    message_type: "operation_receipt",
    ...structuredClone(input),
    failure_code: input.failure_code ?? null,
  };
  try {
    validateCanonicalOperationReceipt(receipt);
  } catch (error) {
    if (error instanceof CanonicalContractError) deny("receipt", error.code, error.details);
    throw error;
  }
  return receipt;
}

export class TenantQuotaCache {
  readonly #decisions = new Map<string, QuotaDecision>();

  set(decision: QuotaDecision): void {
    try {
      validateCanonicalQuotaDecision(decision);
    } catch (error) {
      if (error instanceof CanonicalContractError) deny("quota", error.code, error.details);
      throw error;
    }
    this.#decisions.set(this.#key(decision.tenant_id, decision.contract_revision, decision.unit), structuredClone(decision));
  }

  get(tenantId: string, contractRevision: string, unit: string): QuotaDecision {
    const decision = this.#decisions.get(this.#key(tenantId, contractRevision, unit));
    if (!decision) deny("quota", "UPSTREAM_UNAVAILABLE");
    return structuredClone(decision);
  }

  #key(tenantId: string, contractRevision: string, unit: string): string {
    return JSON.stringify([tenantId, contractRevision, unit]);
  }
}

export function assertQuotaAllowsExecution(decision: QuotaDecision): QuotaDecision {
  if (decision.decision === "hard_stopped") deny("quota", "QUOTA_EXCEEDED");
  if (decision.decision === "approval_required") deny("quota", "QUOTA_APPROVAL_REQUIRED");
  if (decision.decision === "unavailable") deny("quota", "UPSTREAM_UNAVAILABLE");
  return decision;
}

export async function authorizeTenantQuota(input: {
  tenant_id: string;
  contract_revision: string;
  unit: string;
  read_authoritative_decision(request: {
    tenant_id: string;
    contract_revision: string;
    unit: string;
  }): Promise<QuotaDecision>;
}): Promise<QuotaDecision> {
  let decision: QuotaDecision;
  try {
    decision = await input.read_authoritative_decision({
      tenant_id: input.tenant_id,
      contract_revision: input.contract_revision,
      unit: input.unit,
    });
  } catch (error) {
    if (error instanceof TenantBoundaryError) throw error;
    deny("quota", "UPSTREAM_UNAVAILABLE");
  }
  if (!decision || decision.tenant_id !== input.tenant_id) {
    deny("quota", "CROSS_TENANT_CANDIDATE");
  }
  if (decision.contract_revision !== input.contract_revision) {
    deny("quota", "WORKSPACE_CONNECTION_STALE_REVISION");
  }
  if (decision.unit !== input.unit) deny("quota", "CROSS_TENANT_CANDIDATE");
  try {
    validateCanonicalQuotaDecision(decision);
  } catch (error) {
    if (error instanceof CanonicalContractError) deny("quota", error.code, error.details);
    throw error;
  }
  return assertQuotaAllowsExecution(structuredClone(decision));
}

export type OperationReceipt = OperationReceiptInput & {
  message_type: "operation_receipt";
  failure_code: string | null;
};

interface AccountingLedgerClaim {
  disposition: "claimed";
  batch_key: string;
  entity_keys: string[];
}

type AccountingLedgerResult = AccountingLedgerClaim | { disposition: "duplicate" };

/** Tenant-partitioned in-memory port. A Durable Object implementation can preserve these semantics. */
export class TenantAccountingLedger {
  readonly #entities = new Map<string, { batch_key: string; state: "claimed" | "written" }>();

  claim(input: {
    tenant_context: TenantContextEnvelope;
    usage_event_ids: readonly string[];
    receipt_id: string;
  }): AccountingLedgerResult {
    const resourceIds = [...input.usage_event_ids, input.receipt_id];
    const entityKeys = resourceIds.map((resourceId) => tenantPartitionKey({
      tenant_id: input.tenant_context.tenant.tenant_id,
      resource_type: "usage",
      connection_id: input.tenant_context.workspace_connection.connection_id,
      workspace_id: input.tenant_context.workspace_connection.workspace_id,
      channel_id: input.tenant_context.slack.channel_id,
      thread_ts: input.tenant_context.slack.thread_ts ?? "",
      resource_id: resourceId,
    }));
    const batchKey = JSON.stringify(entityKeys);
    const existing = entityKeys.map((key) => this.#entities.get(key));
    if (existing.every((entry) => entry?.state === "written" && entry.batch_key === batchKey)) {
      return { disposition: "duplicate" };
    }
    if (existing.some((entry) => entry !== undefined)) {
      deny("brainbase_proxy", "IDEMPOTENCY_CONFLICT");
    }
    for (const key of entityKeys) this.#entities.set(key, { batch_key: batchKey, state: "claimed" });
    return { disposition: "claimed", batch_key: batchKey, entity_keys: entityKeys };
  }

  complete(claim: AccountingLedgerClaim): void {
    for (const key of claim.entity_keys) {
      const entry = this.#entities.get(key);
      if (!entry || entry.batch_key !== claim.batch_key || entry.state !== "claimed") {
        deny("brainbase_proxy", "IDEMPOTENCY_CONFLICT");
      }
      this.#entities.set(key, { batch_key: claim.batch_key, state: "written" });
    }
  }

  release(claim: AccountingLedgerClaim): void {
    for (const key of claim.entity_keys) {
      const entry = this.#entities.get(key);
      if (entry?.batch_key === claim.batch_key && entry.state === "claimed") this.#entities.delete(key);
    }
  }
}

function assertAccountingScope(
  tenantContext: TenantContextEnvelope,
  expectedScope: ExpectedTenantScope,
  usageEvents: readonly UsageEvent[],
  receipt: OperationReceipt,
): void {
  const matchesContext = (value: {
    protocol_version: string;
    tenant_id: string;
    connection_id: string;
    connection_revision: string;
    contract_revision: string;
    deployment_id: string;
    correlation_id: string;
  }): boolean => value.protocol_version === tenantContext.protocol_version
    && value.tenant_id === tenantContext.tenant.tenant_id
    && value.connection_id === tenantContext.workspace_connection.connection_id
    && value.connection_revision === tenantContext.workspace_connection.connection_revision
    && value.contract_revision === tenantContext.contract_revision
    && value.deployment_id === tenantContext.placement.deployment_id
    && value.correlation_id === tenantContext.correlation_id;
  if (usageEvents.length === 0 || !usageEvents.every(matchesContext) || !matchesContext(receipt)) {
    deny("brainbase_proxy", "CROSS_TENANT_CANDIDATE");
  }
  if (receipt.actor_principal_id !== tenantContext.actor.principal_id
    || receipt.project_id !== expectedScope.project_id
    || receipt.capability_id !== expectedScope.capability_id
    || receipt.credential_mode !== tenantContext.credential.mode
    || usageEvents.some((event) => !receipt.operation_ids.includes(event.operation_id)
      || !receipt.idempotency_keys.includes(event.idempotency_key))) {
    deny("brainbase_proxy", "CAPABILITY_SCOPE_MISMATCH");
  }
}

export async function writeTenantAccounting(input: {
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  now: string;
  verifier: TenantRuntimeBoundaryVerifier;
  ledger: TenantAccountingLedger;
  usage_events: readonly UsageEvent[];
  receipt: OperationReceipt;
  write(payload: {
    partition_key: string;
    usage_events: UsageEvent[];
    receipt: OperationReceipt;
  }): Promise<{ result_ref: string }>;
}): Promise<{ disposition: "written"; result_ref: string } | { disposition: "duplicate" }> {
  await input.verifier.validate({
    boundary: "brainbase_proxy",
    tenant_context: input.tenant_context,
    expected_scope: input.expected_scope,
    now: input.now,
  });
  assertAccountingScope(input.tenant_context, input.expected_scope, input.usage_events, input.receipt);
  const artifact = assertSecretArtifactFree({
    usage_events: input.usage_events.map((event) => structuredClone(event)),
    receipt: structuredClone(input.receipt),
  });
  const claim = input.ledger.claim({
    tenant_context: input.tenant_context,
    usage_event_ids: input.usage_events.map((event) => event.usage_event_id),
    receipt_id: input.receipt.receipt_id,
  });
  if (claim.disposition === "duplicate") return claim;
  const partitionKey = tenantPartitionKey({
    tenant_id: input.tenant_context.tenant.tenant_id,
    resource_type: "usage",
    connection_id: input.tenant_context.workspace_connection.connection_id,
    workspace_id: input.tenant_context.workspace_connection.workspace_id,
    channel_id: input.tenant_context.slack.channel_id,
    thread_ts: input.tenant_context.slack.thread_ts ?? "",
    resource_id: input.receipt.receipt_id,
  });
  try {
    const result = await input.write({ partition_key: partitionKey, ...artifact });
    if (!result?.result_ref) deny("brainbase_proxy", "UPSTREAM_UNAVAILABLE");
    input.ledger.complete(claim);
    return { disposition: "written", result_ref: result.result_ref };
  } catch (error) {
    input.ledger.release(claim);
    if (error instanceof TenantBoundaryError) throw error;
    deny("brainbase_proxy", "UPSTREAM_UNAVAILABLE");
  }
}
