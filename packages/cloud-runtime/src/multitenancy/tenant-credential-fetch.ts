import type {
  CredentialLeaseBinding,
  ExpectedTenantScope,
  TenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "./contracts.js";
import {
  acquireEnvelopeCredentialLease,
  CredentialLeaseUseRegistry,
} from "./credentials.js";
import type { CredentialBrokerClient } from "./credentials.js";
import {
  sanitizeTrustedProviderRequest,
  type TrustedProviderForwarder,
  unavailableTrustedProviderForwarder,
} from "./trusted-provider-forwarder.js";
import { deny } from "./errors.js";

export interface TenantCredentialFetchOptions {
  envelope: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  broker: CredentialBrokerClient;
  trusted_forwarder?: TrustedProviderForwarder;
  read_authoritative_snapshot(): Promise<WorkspaceConnectionSnapshot>;
  resolve_verification_key(keyId: string): Promise<CryptoKey | undefined>;
  now(): string;
}

function credentialTarget(request: Request): URL {
  const target = new URL(request.url);
  if (target.protocol !== "https:" || target.username || target.password
    || (target.port && target.port !== "443") || !target.hostname) {
    deny("credential_lease", "CREDENTIAL_LEASE_BINDING_MISMATCH");
  }
  return target;
}

/**
 * Creates a fetch implementation that never treats the opaque lease token as
 * provider credential material. Every request receives a fresh 60-second,
 * operation-bound lease and is delegated to the Brainbase-owned trusted
 * forwarder port after all caller-supplied provider credentials are stripped.
 */
export function createTenantCredentialFetch(options: TenantCredentialFetchOptions): typeof fetch {
  const usedLeases = new CredentialLeaseUseRegistry();
  const trustedForwarder = options.trusted_forwarder ?? unavailableTrustedProviderForwarder;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const target = credentialTarget(request);
    const observedAt = options.now();
    const lease = await acquireEnvelopeCredentialLease({
      envelope: options.envelope,
      expected_scope: options.expected_scope,
      audience: target.hostname,
      broker: options.broker,
      read_authoritative_snapshot: options.read_authoritative_snapshot,
      resolve_verification_key: options.resolve_verification_key,
      now: observedAt,
    });
    usedLeases.consume(lease.lease_id);
    const expectedBinding: CredentialLeaseBinding = {
      tenant_id: options.envelope.tenant.tenant_id,
      connection_id: options.envelope.workspace_connection.connection_id,
      connection_revision: options.envelope.workspace_connection.connection_revision,
      contract_revision: options.envelope.contract_revision,
      operation_id: options.envelope.operation_id,
      audience: target.hostname,
      credential_mode: options.envelope.credential.mode,
      credential_ref: options.envelope.credential.credential_ref,
    };
    return trustedForwarder.forward({
      lease,
      expected_binding: expectedBinding,
      request: sanitizeTrustedProviderRequest(request),
      now: observedAt,
    });
  };
}
