import type {
  ExpectedTenantScope,
  TenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "./contracts.js";
import { validateTenantBoundary } from "./envelope.js";
import { deny } from "./errors.js";
import { validateCanonicalIdempotencyClaim } from "./canonical-consumer.js";
import {
  claimIdempotency,
  createIdempotencyKey,
  type IdempotencyClaimResult,
  type IdempotencyStore,
} from "./idempotency.js";

export async function authorizeSlackDelivery(input: {
  envelope: TenantContextEnvelope;
  authoritative_snapshot: WorkspaceConnectionSnapshot;
  expected_scope: ExpectedTenantScope;
  now: string;
  resolve_verification_key: (keyId: string) => Promise<CryptoKey | undefined>;
  ownership: IdempotencyStore;
  payload_hash: string;
  delivery_operation_id: string;
  retention_until: string;
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
  const operationId = input.delivery_operation_id;
  const key = await createIdempotencyKey({
    protocol_id: input.envelope.protocol_id,
    protocol_major: "1",
    tenant_id: input.envelope.tenant.tenant_id,
    connection_id: input.envelope.workspace_connection.connection_id,
    slack_event_id: input.envelope.slack.event_id,
    operation_id: operationId,
  });
  const contextDigest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input.envelope.integrity.value),
  ));
  const contextHash = `sha256:${[...contextDigest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  await validateCanonicalIdempotencyClaim({
    message_type: "idempotency_claim",
    owner: "mana_runtime",
    scope: "slack_delivery",
    tenant_id: input.envelope.tenant.tenant_id,
    connection_id: input.envelope.workspace_connection.connection_id,
    slack_event_id: input.envelope.slack.event_id,
    operation_id: operationId,
    idempotency_key: key,
    context_hash: contextHash,
    payload_hash: input.payload_hash,
    state: "claimed",
    retention_until: input.retention_until,
  });
  return claimIdempotency(input.ownership, {
    key,
    owner: "mana_runtime",
    scope: "slack_delivery",
    tenant_id: input.envelope.tenant.tenant_id,
    connection_id: input.envelope.workspace_connection.connection_id,
    slack_event_id: input.envelope.slack.event_id,
    operation_id: operationId,
    context_hash: contextHash,
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
    delivery_operation_id: input.delivery_operation_id,
    retention_until: input.retention_until,
  });
}
