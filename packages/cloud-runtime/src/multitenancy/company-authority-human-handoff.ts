import { TenantBoundaryError } from "./errors.js";
import { jcsCanonicalize } from "./jcs.js";
import type {
  AcceptedCompanyAuthorityContext,
  CompanyAuthorityDesiredEffect,
  ObservedExecutionRequestV1,
} from "./company-authority-runtime-adapter.js";

export type CompanyAuthorityHumanHandoffDecision = "approval" | "human_action";
export type CompanyAuthorityHumanHandoffState = "pending_approval" | "pending_human_action";

export interface CompanyAuthorityHumanHandoffRecord {
  readonly schema_version: "1.0";
  readonly tenant_id: string;
  readonly handoff_id: string;
  readonly execution_hash: string;
  readonly decision: CompanyAuthorityHumanHandoffDecision;
  readonly state: CompanyAuthorityHumanHandoffState;
  readonly target: Readonly<{
    role: "approver" | "responsible";
    person_id: string;
  }>;
  readonly correlation_id: string;
  readonly operation_id: string;
  readonly capability_id: string;
  readonly desired_effect: CompanyAuthorityDesiredEffect;
  readonly organization_id: string;
  readonly project_id: string;
  readonly resource_ref: string;
  readonly revisions: Readonly<{
    policy: string;
    raci: string;
    resource: string;
  }>;
  readonly authority_receipt_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly created_at: string;
  readonly source: Readonly<{
    request: ObservedExecutionRequestV1;
    context: AcceptedCompanyAuthorityContext;
    payload: unknown;
  }>;
}

export interface CompanyAuthorityHumanHandoffStore {
  begin(record: CompanyAuthorityHumanHandoffRecord): Promise<{
    record: CompanyAuthorityHumanHandoffRecord;
    created: boolean;
  }>;
  read(tenantId: string, handoffId: string): Promise<CompanyAuthorityHumanHandoffRecord | null>;
}

function handoffKey(tenantId: string, handoffId: string): string {
  return JSON.stringify([tenantId, handoffId]);
}

function comparableHandoff(record: CompanyAuthorityHumanHandoffRecord): unknown {
  const { created_at: _createdAt, ...immutable } = record;
  return immutable;
}

export function assertSameCompanyAuthorityHumanHandoff(
  existing: CompanyAuthorityHumanHandoffRecord,
  candidate: CompanyAuthorityHumanHandoffRecord,
): void {
  if (existing.tenant_id !== candidate.tenant_id
    || existing.handoff_id !== candidate.handoff_id
    || jcsCanonicalize(comparableHandoff(existing)) !== jcsCanonicalize(comparableHandoff(candidate))) {
    throw new TenantBoundaryError("queue_consumer", "IDEMPOTENCY_CONFLICT", undefined, {
      handoff_id: candidate.handoff_id,
    });
  }
}

export class CompanyAuthorityHumanHandoffMemoryStore implements CompanyAuthorityHumanHandoffStore {
  readonly #records = new Map<string, CompanyAuthorityHumanHandoffRecord>();

  async begin(record: CompanyAuthorityHumanHandoffRecord): Promise<{
    record: CompanyAuthorityHumanHandoffRecord;
    created: boolean;
  }> {
    const key = handoffKey(record.tenant_id, record.handoff_id);
    const existing = this.#records.get(key);
    if (existing) {
      assertSameCompanyAuthorityHumanHandoff(existing, record);
      return { record: structuredClone(existing), created: false };
    }
    this.#records.set(key, structuredClone(record));
    return { record: structuredClone(record), created: true };
  }

  async read(tenantId: string, handoffId: string): Promise<CompanyAuthorityHumanHandoffRecord | null> {
    const record = this.#records.get(handoffKey(tenantId, handoffId));
    return record ? structuredClone(record) : null;
  }
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function invalidHandoff(phase: string): never {
  throw new TenantBoundaryError("queue_consumer", "AUTHORITY_SCOPE_MISMATCH", undefined, { phase });
}

export function companyAuthorityHumanHandoffIdentity(
  context: AcceptedCompanyAuthorityContext,
): { tenant_id: string; handoff_id: string } {
  const tenantContext = context.tenant_context as {
    tenant?: { tenant_id?: unknown };
    idempotency_key?: unknown;
  };
  const tenantId = requiredString(tenantContext.tenant?.tenant_id);
  const handoffId = requiredString(tenantContext.idempotency_key);
  if (!tenantId || !handoffId) invalidHandoff("company_authority_handoff_identity");
  return { tenant_id: tenantId, handoff_id: handoffId };
}

/**
 * Persists an already accepted approval or human-action packet. Persistence is
 * deliberately not notification, approval, completion, or authorization to
 * execute the protected effect.
 */
export async function processCompanyAuthorityHumanHandoff<T>(input: {
  readonly context: AcceptedCompanyAuthorityContext;
  readonly request: ObservedExecutionRequestV1;
  readonly payload: T;
  readonly execution_hash: string;
  readonly store: CompanyAuthorityHumanHandoffStore;
  now(): string;
}): Promise<{ record: CompanyAuthorityHumanHandoffRecord; created: boolean }> {
  const tenantContext = input.context.tenant_context as {
    tenant?: { tenant_id?: unknown };
    idempotency_key?: unknown;
    operation_id?: unknown;
    correlation_id?: unknown;
  };
  const scope = input.context.scope as {
    organization_id?: unknown;
    project_id?: unknown;
    resource_ref?: unknown;
  };
  const authority = input.context.authority;
  const evidence = input.context.evidence as { authority_resolution_receipt_id?: unknown };
  const decision = authority.decision;
  if (decision !== "approval" && decision !== "human_action") {
    invalidHandoff("company_authority_handoff_decision");
  }
  const { tenant_id: tenantId, handoff_id: handoffId } = companyAuthorityHumanHandoffIdentity(input.context);
  const operationId = requiredString(tenantContext.operation_id);
  const correlationId = requiredString(tenantContext.correlation_id);
  const organizationId = requiredString(scope.organization_id);
  const projectId = requiredString(scope.project_id);
  const resourceRef = requiredString(scope.resource_ref);
  const capabilityId = requiredString(authority.capability_id);
  const policyRevision = requiredString(authority.policy_revision);
  const raciRevision = requiredString(authority.raci_revision);
  const resourceRevision = requiredString(authority.resource_revision);
  const authorityReceiptId = requiredString(evidence.authority_resolution_receipt_id);
  if (!operationId || !correlationId || !organizationId || !projectId
    || !resourceRef || !capabilityId || !policyRevision || !raciRevision || !resourceRevision
    || !authorityReceiptId || !requiredString(input.execution_hash)
    || !requiredString(input.context.issued_at) || !requiredString(input.context.expires_at)) {
    invalidHandoff("company_authority_handoff_context");
  }
  const requested = input.request.requested_action;
  if (input.request.correlation_id !== correlationId
    || requested.capability_id !== capabilityId
    || requested.resource_ref !== resourceRef
    || requested.project_hint !== projectId
    || !Array.isArray(authority.allowed_effects)
    || !authority.allowed_effects.includes(requested.desired_effect)) {
    invalidHandoff("company_authority_handoff_binding");
  }
  const approver = requiredString(authority.approver_person_id);
  const responsible = requiredString(authority.responsible_person_id);
  const target = decision === "approval"
    ? approver && authority.responsible_person_id === null
      ? { role: "approver" as const, person_id: approver }
      : invalidHandoff("company_authority_approval_target")
    : responsible && authority.approver_person_id === null
      ? { role: "responsible" as const, person_id: responsible }
      : invalidHandoff("company_authority_human_action_target");
  const record: CompanyAuthorityHumanHandoffRecord = {
    schema_version: "1.0",
    tenant_id: tenantId,
    handoff_id: handoffId,
    execution_hash: input.execution_hash,
    decision,
    state: decision === "approval" ? "pending_approval" : "pending_human_action",
    target,
    correlation_id: correlationId,
    operation_id: operationId,
    capability_id: capabilityId,
    desired_effect: requested.desired_effect,
    organization_id: organizationId,
    project_id: projectId,
    resource_ref: resourceRef,
    revisions: { policy: policyRevision, raci: raciRevision, resource: resourceRevision },
    authority_receipt_id: authorityReceiptId,
    issued_at: input.context.issued_at,
    expires_at: input.context.expires_at,
    created_at: input.now(),
    source: {
      request: structuredClone(input.request),
      context: structuredClone(input.context),
      payload: structuredClone(input.payload),
    },
  };
  return input.store.begin(record);
}
