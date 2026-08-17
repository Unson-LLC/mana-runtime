import type {
  CredentialLease,
  CredentialLeaseBinding,
  CredentialMode,
  ExpectedTenantScope,
  TenantContextEnvelope,
  WorkspaceConnectionSnapshot,
} from "./contracts.js";
import { CanonicalContractError, validateCanonicalCredentialLease } from "./canonical-consumer.js";
import {
  acquireEnvelopeCredentialLease,
  consumeCredentialLease,
  CredentialLeaseUseRegistry,
  type CredentialBrokerClient,
} from "./credentials.js";
import { deny } from "./errors.js";
import { createSecretValue, revealSecretValue, type SecretValue } from "./secret-guard.js";

const MARKER_PREFIX = "mana-credential-lease-v1:";
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const CLOCK_SKEW_MS = 30_000;

interface ActiveCredential {
  readonly secret: SecretValue;
  readonly expires_at: string;
  readonly credential_mode: CredentialMode;
  readonly allowed_hostname: string;
}

function opaqueHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function createCredentialLeaseHandle(): string {
  return opaqueHandle();
}

function assertHostname(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.includes(":") || normalized.includes("/") || normalized !== value) {
    deny("credential_lease", "CREDENTIAL_LEASE_BINDING_MISMATCH");
  }
  return normalized;
}

function validateRegistration(input: {
  lease: CredentialLease;
  expected_binding: CredentialLeaseBinding;
  now: string;
}): void {
  try {
    validateCanonicalCredentialLease({
      message_type: "credential_lease_request",
      protocol_version: input.lease.protocol_version,
      binding: input.expected_binding,
      requested_ttl_seconds: 60,
    }, input.lease, { now: input.now });
  } catch (error) {
    if (error instanceof CanonicalContractError) {
      deny("credential_lease", error.code, error.details);
    }
    throw error;
  }
}

export function credentialLeaseMarker(handle: string): string {
  if (!HANDLE_PATTERN.test(handle)) deny("credential_lease", "CREDENTIAL_LEASE_INVALID");
  return `${MARKER_PREFIX}${handle}`;
}

function handleFromHeaders(headers: Headers): string {
  const authorization = headers.get("authorization") ?? "";
  const marker = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (!marker.startsWith(MARKER_PREFIX)) deny("credential_lease", "CREDENTIAL_LEASE_INVALID");
  const handle = marker.slice(MARKER_PREFIX.length);
  if (!HANDLE_PATTERN.test(handle)) deny("credential_lease", "CREDENTIAL_LEASE_INVALID");
  return handle;
}

/**
 * Volatile, per-isolate credential handoff. Only an opaque handle crosses into
 * the Container. Raw lease material is never serialized or written to storage.
 * The broker remains the authority for cross-isolate single-use enforcement;
 * this injector consumes the local handle before revealing the credential.
 */
export class TenantCredentialInjector {
  readonly #active = new Map<string, ActiveCredential>();
  readonly #usedLeases = new CredentialLeaseUseRegistry();

  async register(input: {
    lease: CredentialLease;
    expected_binding: CredentialLeaseBinding;
    now: string;
    allowed_hostname?: string;
    handle?: string;
  }): Promise<string> {
    validateRegistration(input);
    const allowedHostname = assertHostname(input.allowed_hostname ?? input.expected_binding.audience);
    const handle = input.handle ?? opaqueHandle();
    if (!HANDLE_PATTERN.test(handle)) deny("credential_lease", "CREDENTIAL_LEASE_INVALID");
    const secret = createSecretValue(input.lease.lease_token);
    await consumeCredentialLease(this.#usedLeases, input.lease, secret, async () => {
      this.#active.set(handle, Object.freeze({
        secret,
        expires_at: input.lease.expires_at,
        credential_mode: input.lease.binding.credential_mode,
        allowed_hostname: allowedHostname,
      }));
    }, input.now);
    return handle;
  }

  inject(input: { hostname: string; headers: Headers; now: string }): Headers {
    const handle = handleFromHeaders(input.headers);
    const active = this.#active.get(handle);
    if (!active) deny("credential_lease", "CREDENTIAL_LEASE_INVALID");
    if (assertHostname(input.hostname) !== active.allowed_hostname) {
      deny("credential_lease", "CREDENTIAL_LEASE_BINDING_MISMATCH");
    }
    const observedAt = Date.parse(input.now);
    const expiresAt = Date.parse(active.expires_at);
    if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt)
      || observedAt > expiresAt + CLOCK_SKEW_MS) {
      this.#active.delete(handle);
      deny("credential_lease", "WORKSPACE_CONNECTION_REVOKED");
    }
    this.#active.delete(handle);
    const headers = new Headers(input.headers);
    headers.delete("authorization");
    headers.delete("x-api-key");
    const secret = revealSecretValue(active.secret);
    if (active.credential_mode === "customer_api") headers.set("x-api-key", secret);
    else headers.set("authorization", `Bearer ${secret}`);
    return headers;
  }

  dispose(handle: string): void {
    if (HANDLE_PATTERN.test(handle)) this.#active.delete(handle);
  }

  disposeAll(): void {
    this.#active.clear();
  }

  activeCredentialCount(): number {
    return this.#active.size;
  }
}

export interface TenantCredentialRegistry {
  register(input: {
    lease: CredentialLease;
    expected_binding: CredentialLeaseBinding;
    now: string;
    allowed_hostname?: string;
  }): Promise<string>;
  dispose(handle: string): void | Promise<void>;
}

export const tenantCredentialInjector = new TenantCredentialInjector();

export async function withTenantCredentialLease<T>(input: {
  envelope: TenantContextEnvelope;
  expected_scope: ExpectedTenantScope;
  audience: string;
  broker: CredentialBrokerClient;
  read_authoritative_snapshot(): Promise<WorkspaceConnectionSnapshot>;
  resolve_verification_key(keyId: string): Promise<CryptoKey | undefined>;
  now(): string;
  injector?: TenantCredentialInjector;
  credential_registry?: TenantCredentialRegistry;
  release?: "on_completion" | "on_consumption";
  run(handle: string): Promise<T>;
}): Promise<T> {
  const registry: TenantCredentialRegistry = input.credential_registry ?? input.injector ?? tenantCredentialInjector;
  const observedAt = input.now();
  const lease = await acquireEnvelopeCredentialLease({
    envelope: input.envelope,
    expected_scope: input.expected_scope,
    audience: input.audience,
    broker: input.broker,
    read_authoritative_snapshot: input.read_authoritative_snapshot,
    now: observedAt,
    resolve_verification_key: input.resolve_verification_key,
  });
  const handle = await registry.register({
    lease,
    expected_binding: {
      tenant_id: input.envelope.tenant.tenant_id,
      connection_id: input.envelope.workspace_connection.connection_id,
      connection_revision: input.envelope.workspace_connection.connection_revision,
      contract_revision: input.envelope.contract_revision,
      operation_id: input.envelope.operation_id,
      audience: input.audience,
      credential_mode: input.envelope.credential.mode,
      credential_ref: input.envelope.credential.credential_ref,
    },
    now: observedAt,
    allowed_hostname: input.audience,
  });
  try {
    return await input.run(handle);
  } finally {
    if (input.release !== "on_consumption") await registry.dispose(handle);
  }
}
