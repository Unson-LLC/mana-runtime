import type {
  ExpectedTenantScope,
  TenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "./contracts.js";
import {
  credentialLeaseMarker,
  type TenantCredentialRegistry,
  withTenantCredentialLease,
} from "./credential-injector.js";
import type { CredentialBrokerClient } from "./credentials.js";
import {
  forwardTenantCredentialRequest,
  type TenantCredentialRelayNamespace,
} from "./durable-credential-relay.js";
import { deny } from "./errors.js";

export interface TenantCredentialFetchOptions {
  envelope: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  broker: CredentialBrokerClient;
  credential_registry: TenantCredentialRegistry;
  credential_relay: TenantCredentialRelayNamespace;
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
 * Creates a fetch implementation that never exposes provider credentials to
 * the Worker isolate. Every HTTP request receives a fresh 60-second,
 * operation-bound lease; only an opaque marker crosses to the durable relay,
 * where the lease is consumed exactly once at provider outbound.
 */
export function createTenantCredentialFetch(options: TenantCredentialFetchOptions): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const target = credentialTarget(request);
    return withTenantCredentialLease({
      envelope: options.envelope,
      expected_scope: options.expected_scope,
      audience: target.hostname,
      broker: options.broker,
      credential_registry: options.credential_registry,
      read_authoritative_snapshot: options.read_authoritative_snapshot,
      resolve_verification_key: options.resolve_verification_key,
      now: options.now,
      release: "on_consumption",
      run: async (handle) => {
        const headers = new Headers(request.headers);
        headers.delete("authorization");
        headers.delete("x-api-key");
        headers.set("authorization", `Bearer ${credentialLeaseMarker(handle)}`);
        const outbound = new Request(request, { headers, redirect: "manual" });
        return forwardTenantCredentialRequest(options.credential_relay, outbound, options.now());
      },
    });
  };
}
