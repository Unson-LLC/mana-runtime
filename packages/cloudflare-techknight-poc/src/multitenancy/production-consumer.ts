import {
  authorizeTenantQuota,
  createOperationReceipt,
  createUsageEvent,
  writeTenantAccounting,
  type TenantAccountingLedgerStore,
} from "./accounting.js";
import type {
  ExpectedTenantScope,
  OperationOutcome,
  QuotaDecision,
  TenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "./contracts.js";
import { authorizeSlackDeliveryWithAuthority } from "./delivery.js";
import { deny, TenantBoundaryError } from "./errors.js";
import { completeIdempotency, type IdempotencyStore, releaseIdempotency } from "./idempotency.js";
import { createDeterministicSharedId } from "./ids.js";
import { jcsCanonicalize } from "./jcs.js";
import type { TenantAccountingHttpClient, TenantQuotaHttpClient } from "./http-clients.js";
import type { TenantRuntimeBoundaryVerifier } from "./runtime-boundaries.js";

interface RuntimeProcessResult {
  outcome?: string;
  responseTs?: string;
  accounting?: "deferred" | "already_recorded";
}

function quotaDisposition(code: string): QuotaDecision["decision"] {
  if (code === "QUOTA_EXCEEDED") return "hard_stopped";
  if (code === "QUOTA_APPROVAL_REQUIRED") return "approval_required";
  return "unavailable";
}

function errorCode(error: unknown): string {
  if (error instanceof TenantBoundaryError) return error.code;
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "UPSTREAM_UNAVAILABLE";
}

function operationReceiptId(tenantContext: TenantContextEnvelope, effectId?: string): Promise<string> {
  const seed = `${tenantContext.correlation_id}:${tenantContext.operation_id}:${effectId ?? "operation"}`;
  return createDeterministicSharedId("receipt_", `${seed}:receipt`);
}

async function recordOperation(input: {
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  verifier: TenantRuntimeBoundaryVerifier;
  ledger: TenantAccountingLedgerStore;
  accounting: TenantAccountingHttpClient;
  quota_decision: QuotaDecision["decision"];
  unit: string;
  outcome: OperationOutcome;
  failure_code: string | null;
  response_ts?: string;
  operation_result?: unknown;
  accounting_effect_id?: string;
  now: string;
}): Promise<void> {
  const seed = `${input.tenant_context.correlation_id}:${input.tenant_context.operation_id}:${input.accounting_effect_id ?? "operation"}`;
  const receiptId = await operationReceiptId(input.tenant_context, input.accounting_effect_id);
  const recordedAt = await input.ledger.reserve_timestamp({
    tenant_context: input.tenant_context,
    receipt_id: receiptId,
    proposed_at: input.now,
  });
  const usageEvent = createUsageEvent({
    usage_event_id: await createDeterministicSharedId("usage_", `${seed}:usage`),
    protocol_version: input.tenant_context.protocol_version,
    tenant_id: input.tenant_context.tenant.tenant_id,
    connection_id: input.tenant_context.workspace_connection.connection_id,
    connection_revision: input.tenant_context.workspace_connection.connection_revision,
    contract_revision: input.tenant_context.contract_revision,
    deployment_id: input.tenant_context.placement.deployment_id,
    correlation_id: input.tenant_context.correlation_id,
    operation_id: input.tenant_context.operation_id,
    idempotency_key: input.tenant_context.idempotency_key,
    kind: "runtime_operation",
    quantity: null,
    unit: input.unit,
    collection_state: "not_collected",
    outcome: input.outcome,
    failure_code: input.failure_code,
    unknown_fields: ["observed_units"],
    observed_at: recordedAt,
  });
  const receipt = createOperationReceipt({
    receipt_id: receiptId,
    protocol_version: input.tenant_context.protocol_version,
    tenant_id: input.tenant_context.tenant.tenant_id,
    connection_id: input.tenant_context.workspace_connection.connection_id,
    connection_revision: input.tenant_context.workspace_connection.connection_revision,
    contract_revision: input.tenant_context.contract_revision,
    deployment_id: input.tenant_context.placement.deployment_id,
    correlation_id: input.tenant_context.correlation_id,
    operation_ids: [input.tenant_context.operation_id],
    idempotency_keys: [input.tenant_context.idempotency_key],
    actor_principal_id: input.tenant_context.actor.principal_id,
    project_id: input.expected_scope.project_id,
    capability_id: input.expected_scope.capability_id,
    quota_decision: input.quota_decision,
    credential_mode: input.tenant_context.credential.mode,
    collection_state: "not_collected",
    outcome: input.outcome,
    failure_code: input.failure_code,
    usage_event_ids: [usageEvent.usage_event_id],
    reply: input.response_ts
      ? { state: "delivered", reply_count: 1, legacy_reply_count: 0, slack_reply_ts: input.response_ts }
      : { state: "not_attempted", reply_count: 0, legacy_reply_count: 0 },
    completed_at: recordedAt,
  });
  await writeTenantAccounting({
    tenant_context: input.tenant_context,
    expected_scope: input.expected_scope,
    now: input.now,
    verifier: input.verifier,
    ledger: input.ledger,
    usage_events: [usageEvent],
    receipt,
    ...(input.operation_result === undefined ? {} : { operation_result: input.operation_result }),
    write: (payload) => input.accounting.write(payload),
  });
}

export async function executeTenantRuntimeOperation<R extends RuntimeProcessResult>(input: {
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  verifier: TenantRuntimeBoundaryVerifier;
  quota: TenantQuotaHttpClient;
  accounting: TenantAccountingHttpClient;
  ledger: TenantAccountingLedgerStore;
  quota_unit: string;
  now(): string;
  process(quotaDecision: QuotaDecision): Promise<R>;
  replay_after_accounting?(): Promise<R>;
  accounting_effect_id?: string;
}): Promise<R> {
  if (!input.quota_unit.trim()) deny("runtime_configuration", "CONFIGURATION_INVALID");
  const receiptId = await operationReceiptId(input.tenant_context, input.accounting_effect_id);
  const pending = await input.ledger.read_pending({
    tenant_context: input.tenant_context,
    receipt_id: receiptId,
  });
  if (pending) {
    const pendingResult = await input.ledger.read_pending_result({
      tenant_context: input.tenant_context,
      receipt_id: receiptId,
    });
    await writeTenantAccounting({
      tenant_context: input.tenant_context,
      expected_scope: input.expected_scope,
      now: input.now(),
      verifier: input.verifier,
      ledger: input.ledger,
      usage_events: pending.usage_events,
      receipt: pending.receipt,
      ...(pendingResult === undefined ? {} : { operation_result: pendingResult }),
      write: (payload) => input.accounting.write(payload),
    });
    if (pending.receipt.outcome !== "succeeded") {
      deny("brainbase_proxy", pending.receipt.failure_code ?? "UPSTREAM_UNAVAILABLE");
    }
    if (pendingResult !== undefined) return structuredClone(pendingResult) as R;
    if (input.replay_after_accounting) return input.replay_after_accounting();
    const responseTs = pending.receipt.reply.slack_reply_ts;
    return {
      outcome: "already_completed",
      ...(responseTs ? { responseTs } : {}),
    } as R;
  }
  let quotaDecision: QuotaDecision;
  try {
    quotaDecision = await authorizeTenantQuota({
      tenant_id: input.tenant_context.tenant.tenant_id,
      contract_revision: input.tenant_context.contract_revision,
      unit: input.quota_unit,
      read_authoritative_decision: (request) => input.quota.read_authoritative_decision(request),
    });
  } catch (error) {
    const code = errorCode(error);
    await recordOperation({
      tenant_context: input.tenant_context,
      expected_scope: input.expected_scope,
      verifier: input.verifier,
      ledger: input.ledger,
      accounting: input.accounting,
      quota_decision: quotaDisposition(code),
      unit: input.quota_unit,
      outcome: "failed",
      failure_code: code,
      ...(input.accounting_effect_id ? { accounting_effect_id: input.accounting_effect_id } : {}),
      now: input.now(),
    });
    throw error;
  }
  let result: R;
  try {
    result = await input.process(quotaDecision);
  } catch (error) {
    const code = errorCode(error);
    await recordOperation({
      tenant_context: input.tenant_context,
      expected_scope: input.expected_scope,
      verifier: input.verifier,
      ledger: input.ledger,
      accounting: input.accounting,
      quota_decision: quotaDecision.decision,
      unit: input.quota_unit,
      outcome: "failed",
      failure_code: code,
      ...(input.accounting_effect_id ? { accounting_effect_id: input.accounting_effect_id } : {}),
      now: input.now(),
    });
    throw error;
  }
  if (result.accounting === "deferred" || result.accounting === "already_recorded") return result;
  await recordOperation({
    tenant_context: input.tenant_context,
    expected_scope: input.expected_scope,
    verifier: input.verifier,
    ledger: input.ledger,
    accounting: input.accounting,
    quota_decision: quotaDecision.decision,
    unit: input.quota_unit,
    outcome: "succeeded",
    failure_code: null,
    ...(result.responseTs ? { response_ts: result.responseTs } : {}),
    operation_result: result,
    ...(input.accounting_effect_id ? { accounting_effect_id: input.accounting_effect_id } : {}),
    now: input.now(),
  });
  return result;
}

export async function recordTenantRuntimeTerminalOperation(input: {
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  verifier: TenantRuntimeBoundaryVerifier;
  accounting: TenantAccountingHttpClient;
  ledger: TenantAccountingLedgerStore;
  quota_decision: QuotaDecision["decision"];
  unit: string;
  outcome: OperationOutcome;
  failure_code: string | null;
  response_ts?: string;
  now: string;
  accounting_effect_id?: string;
}): Promise<void> {
  await recordOperation({ ...input });
}

async function payloadHash(value: unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(jcsCanonicalize(value)),
  ));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function postTenantSlackReply(input: {
  tenant_context: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  ownership: IdempotencyStore;
  read_authoritative_snapshot(): Promise<WorkspaceConnectionSnapshot>;
  resolve_verification_key(keyId: string): Promise<CryptoKey | undefined>;
  now: string;
  retention_until: string;
  event: unknown;
  text: string;
  effect_id?: string;
  post(): Promise<string>;
}): Promise<string> {
  const deliveryOperationId = await createDeterministicSharedId(
    "op_",
    `${input.tenant_context.operation_id}:slack_delivery:${input.effect_id ?? "reply"}`,
  );
  const claim = await authorizeSlackDeliveryWithAuthority({
    envelope: input.tenant_context,
    expected_scope: input.expected_scope,
    now: input.now,
    resolve_verification_key: input.resolve_verification_key,
    ownership: input.ownership,
    payload_hash: await payloadHash({ event: input.event, text: input.text }),
    delivery_operation_id: deliveryOperationId,
    retention_until: input.retention_until,
    read_authoritative_snapshot: input.read_authoritative_snapshot,
  });
  if (claim.disposition === "succeeded" && claim.claim.result_ref) return claim.claim.result_ref;
  if (claim.disposition !== "claimed") deny("slack_delivery", "REPLY_OWNERSHIP_CONFLICT");
  try {
    const responseTs = await input.post();
    await completeIdempotency(input.ownership, {
      key: claim.claim.key,
      tenant_id: input.tenant_context.tenant.tenant_id,
      state: "succeeded",
      result_ref: responseTs,
      updated_at: input.now,
      retained_until: input.retention_until,
      partition_key: claim.claim.partition_key,
    });
    return responseTs;
  } catch (error) {
    await releaseIdempotency(input.ownership, claim.claim.key,
      input.tenant_context.tenant.tenant_id, claim.claim.partition_key);
    throw error;
  }
}
