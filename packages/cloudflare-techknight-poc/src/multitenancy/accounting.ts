import type { CollectionState, OperationOutcome, QuotaDecision } from "./contracts.js";
import { deny } from "./errors.js";

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
  failure_code?: string;
  observed_at: string;
  unknown_fields?: string[];
}

export interface UsageEvent extends UsageEventInput {
  schema_version: "1.0";
}

export function createUsageEvent(input: UsageEventInput): UsageEvent {
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
  return { schema_version: "1.0", ...structuredClone(input) };
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
  outcome: OperationOutcome;
  failure_code?: string;
  usage: {
    collection_state: CollectionState;
    observed_units: number | null;
    unknown_fields: string[];
  };
  reply: { state: "not_requested" | "claimed" | "delivered" | "failed" };
}

export function createOperationReceipt(input: OperationReceiptInput): OperationReceiptInput & { schema_version: "1.0" } {
  if (input.operation_ids.length === 0 || input.idempotency_keys.length === 0) deny("receipt", "RECEIPT_INVALID");
  if (input.usage.collection_state === "not_collected" && input.usage.observed_units !== null) {
    deny("receipt", "USAGE_COLLECTION_INVALID");
  }
  if (input.usage.collection_state === "collected" && input.usage.observed_units === null) {
    deny("receipt", "USAGE_COLLECTION_INVALID");
  }
  return { schema_version: "1.0", ...structuredClone(input) };
}

export class TenantQuotaCache {
  readonly #decisions = new Map<string, QuotaDecision>();

  set(decision: QuotaDecision): void {
    this.#decisions.set(this.#key(decision.tenant_id, decision.contract_revision, decision.metric), structuredClone(decision));
  }

  get(tenantId: string, contractRevision: string, metric: string): QuotaDecision {
    const decision = this.#decisions.get(this.#key(tenantId, contractRevision, metric));
    if (!decision) deny("quota", "UPSTREAM_UNAVAILABLE");
    return structuredClone(decision);
  }

  #key(tenantId: string, contractRevision: string, metric: string): string {
    return JSON.stringify([tenantId, contractRevision, metric]);
  }
}

export function assertQuotaAllowsExecution(decision: QuotaDecision): QuotaDecision {
  if (decision.decision === "hard_stopped") deny("quota", "QUOTA_EXCEEDED");
  if (decision.decision === "approval_required") deny("quota", "QUOTA_APPROVAL_REQUIRED");
  if (decision.decision === "unavailable") deny("quota", "UPSTREAM_UNAVAILABLE");
  return decision;
}
