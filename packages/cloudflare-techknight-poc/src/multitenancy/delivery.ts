import type {
  ExpectedTenantScope,
  TenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "./contracts.js";
import { validateTenantBoundary } from "./envelope.js";
import { deny } from "./errors.js";
import {
  claimIdempotency,
  createIdempotencyKey,
  type IdempotencyClaimResult,
  type IdempotencyMemoryStore,
} from "./idempotency.js";

export async function authorizeSlackDelivery(input: {
  envelope: TenantContextEnvelope;
  authoritative_snapshot: WorkspaceConnectionSnapshot;
  expected_scope: ExpectedTenantScope;
  now: string;
  resolve_verification_key: (keyId: string) => Promise<CryptoKey | undefined>;
  ownership: IdempotencyMemoryStore;
  payload_hash: string;
}): Promise<IdempotencyClaimResult> {
  if (input.authoritative_snapshot.deployment_id !== input.envelope.placement.deployment_id) {
    deny("slack_delivery", "REPLY_OWNERSHIP_CONFLICT");
  }
  await validateTenantBoundary({
    boundary: "slack_delivery",
    envelope: input.envelope,
    authoritative_snapshot: input.authoritative_snapshot,
    expected_scope: input.expected_scope,
    now: input.now,
    resolve_verification_key: input.resolve_verification_key,
  });
  const operationId = `${input.envelope.operation_id}:slack_delivery`;
  const key = await createIdempotencyKey({
    protocol_id: input.envelope.protocol_id,
    protocol_major: "1",
    tenant_id: input.envelope.tenant.tenant_id,
    connection_id: input.envelope.workspace_connection.connection_id,
    slack_event_id: input.envelope.slack.event_id,
    operation_id: operationId,
  });
  return claimIdempotency(input.ownership, {
    key,
    tenant_id: input.envelope.tenant.tenant_id,
    connection_id: input.envelope.workspace_connection.connection_id,
    slack_event_id: input.envelope.slack.event_id,
    operation_id: operationId,
    context_hash: input.envelope.integrity.value,
    payload_hash: input.payload_hash,
    connection_revision: input.envelope.workspace_connection.connection_revision,
    updated_at: input.now,
  });
}

export async function authorizeSlackDeliveryWithAuthority(input: Omit<
  Parameters<typeof authorizeSlackDelivery>[0], "authoritative_snapshot"
> & {
  read_authoritative_snapshot: () => Promise<WorkspaceConnectionSnapshot>;
}): Promise<IdempotencyClaimResult> {
  const authoritativeSnapshot = await input.read_authoritative_snapshot();
  return authorizeSlackDelivery({
    envelope: input.envelope,
    authoritative_snapshot: authoritativeSnapshot,
    expected_scope: input.expected_scope,
    now: input.now,
    resolve_verification_key: input.resolve_verification_key,
    ownership: input.ownership,
    payload_hash: input.payload_hash,
  });
}
