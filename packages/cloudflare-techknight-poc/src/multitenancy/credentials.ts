import type {
  CredentialLease,
  CredentialLeaseRequest,
  ExpectedTenantScope,
  TenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "./contracts.js";
import { CanonicalContractError, validateCanonicalCredentialLease } from "./canonical-consumer.js";
import { validateTenantBoundary } from "./envelope.js";
import { deny } from "./errors.js";

export interface CredentialBrokerClient {
  acquire_lease(request: CredentialLeaseRequest, tenantContext?: TenantContextEnvelope): Promise<CredentialLease>;
}

function assertLeaseBinding(
  request: CredentialLeaseRequest,
  lease: CredentialLease,
  now: string,
): void {
  const fields = [
    "tenant_id",
    "connection_id",
    "connection_revision",
    "contract_revision",
    "operation_id",
    "audience",
    "credential_mode",
    "credential_ref",
  ] as const;
  if (fields.some((field) => lease.binding[field] !== request.binding[field])) {
    deny("credential_lease", "CREDENTIAL_LEASE_BINDING_MISMATCH");
  }
  try {
    validateCanonicalCredentialLease(request, lease, { now });
  } catch (error) {
    if (error instanceof CanonicalContractError) deny("credential_lease", error.code, error.details);
    throw error;
  }
}

export async function acquireCredentialLease(input: {
  broker: CredentialBrokerClient;
  request: CredentialLeaseRequest;
  read_authoritative_snapshot: () => Promise<WorkspaceConnectionSnapshot>;
  now: string;
}): Promise<CredentialLease> {
  const snapshot = await input.read_authoritative_snapshot();
  if (snapshot.status !== "active") deny("credential_lease", "WORKSPACE_CONNECTION_REVOKED");
  if (snapshot.tenant_id !== input.request.binding.tenant_id
    || snapshot.connection_id !== input.request.binding.connection_id
    || snapshot.connection_revision !== input.request.binding.connection_revision
    || snapshot.contract_revision !== input.request.binding.contract_revision
    || snapshot.credential_mode !== input.request.binding.credential_mode) {
    deny("credential_lease", "WORKSPACE_CONNECTION_STALE_REVISION");
  }
  const lease = await input.broker.acquire_lease(structuredClone(input.request));
  assertLeaseBinding(input.request, lease, input.now);
  return lease;
}

export async function acquireEnvelopeCredentialLease(input: {
  envelope: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  audience: string;
  broker: CredentialBrokerClient;
  read_authoritative_snapshot: () => Promise<WorkspaceConnectionSnapshot>;
  now: string;
  resolve_verification_key: (keyId: string) => Promise<CryptoKey | undefined>;
}): Promise<CredentialLease> {
  const snapshot = await input.read_authoritative_snapshot();
  await validateTenantBoundary({
    boundary: "credential_lease",
    envelope: input.envelope,
    authoritative_snapshot: snapshot,
    expected_scope: input.expected_scope,
    now: input.now,
    resolve_verification_key: input.resolve_verification_key,
  });
  const request: CredentialLeaseRequest = {
    message_type: "credential_lease_request",
    protocol_version: input.envelope.protocol_version,
    binding: {
      tenant_id: input.envelope.tenant.tenant_id,
      connection_id: input.envelope.workspace_connection.connection_id,
      connection_revision: input.envelope.workspace_connection.connection_revision,
      contract_revision: input.envelope.contract_revision,
      operation_id: input.envelope.operation_id,
      audience: input.audience,
      credential_mode: input.envelope.credential.mode,
      credential_ref: input.envelope.credential.credential_ref,
    },
    requested_ttl_seconds: 60,
  };
  const contextBoundBroker: CredentialBrokerClient = {
    acquire_lease: (request) => input.broker.acquire_lease(request, input.envelope),
  };
  return acquireCredentialLease({
    broker: contextBoundBroker,
    request,
    read_authoritative_snapshot: input.read_authoritative_snapshot,
    now: input.now,
  });
}

export class CredentialLeaseUseRegistry {
  readonly #used = new Set<string>();

  consume(leaseId: string): void {
    if (this.#used.has(leaseId)) deny("credential_lease", "FALLBACK_FORBIDDEN");
    this.#used.add(leaseId);
  }
}

export interface CredentialLifecycleEvent {
  tenant_id: string;
  connection_id: string;
  credential_ref_hash: string;
  from_revision: string;
  to_revision: string;
  outcome: "refreshed" | "conflict" | "failed" | "revoked";
  correlation_id: string;
  occurred_at: string;
}

export function applyCredentialLifecycleEvent(
  cache: Map<string, WorkspaceConnectionSnapshot>,
  event: CredentialLifecycleEvent,
): void {
  const cached = cache.get(event.connection_id);
  if (!cached) return;
  if (cached.tenant_id !== event.tenant_id || cached.connection_revision !== event.from_revision) {
    deny("credential_lifecycle", "CROSS_TENANT_CANDIDATE");
  }
  cache.delete(event.connection_id);
}
