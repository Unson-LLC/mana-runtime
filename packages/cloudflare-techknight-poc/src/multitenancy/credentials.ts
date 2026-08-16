import type {
  CredentialLease,
  CredentialLeaseRequest,
  WorkspaceConnectionSnapshot,
} from "./contracts.js";
import { deny } from "./errors.js";
import { revealSecretValue, type SecretValue } from "./secret-guard.js";

export interface CredentialBrokerClient {
  acquire_lease(request: CredentialLeaseRequest): Promise<CredentialLease>;
}

function assertLeaseBinding(
  request: CredentialLeaseRequest,
  lease: CredentialLease,
  now: string,
): void {
  const fields: (keyof CredentialLeaseRequest)[] = [
    "tenant_id",
    "connection_id",
    "connection_revision",
    "contract_revision",
    "operation_id",
    "audience",
    "credential_mode",
    "credential_ref",
  ];
  if (fields.some((field) => lease[field] !== request[field])) deny("credential_lease", "CROSS_TENANT_CANDIDATE");
  const issuedAt = Date.parse(lease.issued_at);
  const expiresAt = Date.parse(lease.expires_at);
  const observedAt = Date.parse(now);
  if (![issuedAt, expiresAt, observedAt].every(Number.isFinite)
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > 60_000
    || issuedAt > observedAt + 30_000
    || expiresAt < observedAt - 30_000
    || lease.max_uses !== 1) {
    deny("credential_lease", "CROSS_TENANT_CANDIDATE");
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
  if (snapshot.tenant_id !== input.request.tenant_id
    || snapshot.connection_id !== input.request.connection_id
    || snapshot.connection_revision !== input.request.connection_revision
    || snapshot.contract_revision !== input.request.contract_revision
    || snapshot.credential_mode !== input.request.credential_mode) {
    deny("credential_lease", "WORKSPACE_CONNECTION_STALE_REVISION");
  }
  const lease = await input.broker.acquire_lease(structuredClone(input.request));
  assertLeaseBinding(input.request, lease, input.now);
  return lease;
}

export class CredentialLeaseUseRegistry {
  readonly #used = new Set<string>();

  consume(leaseId: string): void {
    if (this.#used.has(leaseId)) deny("credential_lease", "FALLBACK_FORBIDDEN");
    this.#used.add(leaseId);
  }
}

export async function consumeCredentialLease<T>(
  registry: CredentialLeaseUseRegistry,
  lease: CredentialLease,
  secret: SecretValue,
  inject: (secret: string) => T | Promise<T>,
  now: string,
): Promise<T> {
  const observedAt = Date.parse(now);
  if (!Number.isFinite(observedAt) || observedAt > Date.parse(lease.expires_at) + 30_000) {
    deny("credential_lease", "WORKSPACE_CONNECTION_REVOKED");
  }
  registry.consume(lease.lease_id);
  return inject(revealSecretValue(secret));
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
