import type { QuotaDecision, TenantContextEnvelope } from "./contracts.js";
import {
  claimIdempotency,
  completeIdempotency,
  createIdempotencyKey,
  releaseIdempotency,
  type IdempotencyClaim,
  type IdempotencyStore,
} from "./idempotency.js";
import { jcsCanonicalize } from "./jcs.js";

export interface DevelopmentJobOwner {
  tenantId: string;
  connectionId: string;
  connectionRevision: string;
  operationId: string;
  eventId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  requesterId: string;
  placementId: string;
  jobId: string;
  quotaDecision: QuotaDecision["decision"];
  contextHash: string;
}

async function hash(value: unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(jcsCanonicalize(value)),
  ));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function developmentTenantContextHash(
  tenantContext: TenantContextEnvelope,
): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(tenantContext.integrity.value),
  ));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function developmentOwnerFromContext(input: {
  tenant_context: TenantContextEnvelope;
  jobId: string;
  eventId: string;
  requesterId: string;
  placementId: string;
  quotaDecision: QuotaDecision["decision"];
}): Promise<DevelopmentJobOwner> {
  return {
    tenantId: input.tenant_context.tenant.tenant_id,
    connectionId: input.tenant_context.workspace_connection.connection_id,
    connectionRevision: input.tenant_context.workspace_connection.connection_revision,
    operationId: input.tenant_context.operation_id,
    eventId: input.eventId,
    workspaceId: input.tenant_context.workspace_connection.workspace_id,
    channelId: input.tenant_context.slack.channel_id,
    threadTs: input.tenant_context.slack.thread_ts ?? "",
    requesterId: input.requesterId,
    placementId: input.placementId,
    jobId: input.jobId,
    quotaDecision: input.quotaDecision,
    contextHash: await developmentTenantContextHash(input.tenant_context),
  };
}

export async function claimDevelopmentJobOwner(
  store: IdempotencyStore,
  owner: DevelopmentJobOwner,
  now: string,
): Promise<{ disposition: "claimed" | "in_progress" | "succeeded" | "failed_terminal"; claim: IdempotencyClaim }> {
  const operationId = `${owner.operationId}:development_job:${owner.jobId}`;
  const key = await createIdempotencyKey({
    protocol_id: "mana-brainbase-tenant-context",
    protocol_major: "1",
    tenant_id: owner.tenantId,
    connection_id: owner.connectionId,
    slack_event_id: owner.eventId,
    operation_id: operationId,
  });
  return claimIdempotency(store, {
    key,
    tenant_id: owner.tenantId,
    connection_id: owner.connectionId,
    slack_event_id: owner.eventId,
    operation_id: operationId,
    owner: "mana_runtime",
    scope: "business_effect",
    context_hash: owner.contextHash,
    payload_hash: await hash(owner),
    connection_revision: owner.connectionRevision,
    updated_at: now,
  });
}

export function releaseDevelopmentJobOwner(
  store: IdempotencyStore,
  owner: DevelopmentJobOwner,
  claim: Pick<IdempotencyClaim, "key" | "partition_key">,
): Promise<void> | void {
  return releaseIdempotency(store, claim.key, owner.tenantId, claim.partition_key);
}

export function completeDevelopmentJobOwner(
  store: IdempotencyStore,
  owner: DevelopmentJobOwner,
  claim: Pick<IdempotencyClaim, "key" | "partition_key">,
  now: string,
  retainedUntil: string,
): Promise<IdempotencyClaim> | IdempotencyClaim {
  return completeIdempotency(store, {
    key: claim.key,
    tenant_id: owner.tenantId,
    state: "succeeded",
    result_ref: owner.jobId,
    updated_at: now,
    retained_until: retainedUntil,
    partition_key: claim.partition_key,
  });
}

export function failDevelopmentJobOwner(
  store: IdempotencyStore,
  owner: DevelopmentJobOwner,
  claim: Pick<IdempotencyClaim, "key" | "partition_key">,
  now: string,
  retainedUntil: string,
): Promise<IdempotencyClaim> | IdempotencyClaim {
  return completeIdempotency(store, {
    key: claim.key,
    tenant_id: owner.tenantId,
    state: "failed_terminal",
    result_ref: `${owner.jobId}:terminal_not_collected`,
    updated_at: now,
    retained_until: retainedUntil,
    partition_key: claim.partition_key,
  });
}
