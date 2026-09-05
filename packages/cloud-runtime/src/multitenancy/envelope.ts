import {
  TENANT_CONTEXT_CLOCK_SKEW_SECONDS,
  TENANT_CONTEXT_MAX_TTL_SECONDS,
  TENANT_PROTOCOL_ID,
  type BoundaryName,
  type ExpectedTenantScope,
  type TenantContextEnvelope,
  type UnsignedTenantContextEnvelope,
  type WorkspaceConnectionSnapshot,
} from "./contracts.js";
import { deny } from "./errors.js";
import { CanonicalContractError, validateCanonicalEnvelope } from "./canonical-consumer.js";
import { assertCanonicalSharedId } from "./ids.js";
import { jcsCanonicalize } from "./jcs.js";
import { assertSecretArtifactFree } from "./secret-guard.js";

export { jcsCanonicalize } from "./jcs.js";

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function unsignedEnvelope(envelope: TenantContextEnvelope): UnsignedTenantContextEnvelope {
  const { integrity: _integrity, ...unsigned } = envelope;
  return unsigned;
}

function signingInput(protectedHeader: string, payload: UnsignedTenantContextEnvelope): Uint8Array {
  return encoder.encode(`${protectedHeader}.${jcsCanonicalize(payload)}`);
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

export async function signTenantContextEnvelope(
  envelope: UnsignedTenantContextEnvelope,
  privateKey: CryptoKey,
  keyId: string,
): Promise<TenantContextEnvelope> {
  assertEnvelopeShape(envelope, "worker_ingress");
  const protectedHeader = base64UrlEncode(encoder.encode(jcsCanonicalize({
    alg: "EdDSA",
    b64: false,
    crit: ["b64"],
    kid: keyId,
    typ: "application/mana-brainbase-tenant-context+jws",
  })));
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    asArrayBuffer(signingInput(protectedHeader, envelope)),
  ));
  return {
    ...structuredClone(envelope),
    integrity: {
      method: "jws_detached",
      algorithm: "EdDSA",
      key_id: keyId,
      value: `${protectedHeader}..${base64UrlEncode(signature)}`,
    },
  };
}

function assertNonEmpty(value: unknown, boundary: BoundaryName, code = "TENANT_CONTEXT_INVALID"): asserts value is string {
  if (typeof value !== "string" || value.length === 0) deny(boundary, code);
}

function assertSnakeCaseKeys(value: unknown, boundary: BoundaryName): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertSnakeCaseKeys(entry, boundary);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) deny(boundary, "TENANT_CONTEXT_SCHEMA_INVALID", { key });
    assertSnakeCaseKeys(entry, boundary);
  }
}

function assertEnvelopeShape(
  envelope: UnsignedTenantContextEnvelope | TenantContextEnvelope,
  boundary: BoundaryName,
): void {
  if (!envelope || typeof envelope !== "object") deny(boundary, "TENANT_CONTEXT_SCHEMA_INVALID");
  assertSecretArtifactFree(envelope);
  assertSnakeCaseKeys(envelope, boundary);
  if (envelope.schema_version !== "1.0" || envelope.protocol_id !== TENANT_PROTOCOL_ID || !/^1\.\d+$/.test(envelope.protocol_version)) {
    deny(boundary, "PROTOCOL_VERSION_UNSUPPORTED");
  }
  if (envelope.issuer !== "brainbase" || !Array.isArray(envelope.audience) || envelope.audience.length === 0) {
    deny(boundary, "TENANT_CONTEXT_SCHEMA_INVALID");
  }
  assertNonEmpty(envelope.tenant?.tenant_id, boundary, "TENANT_UNKNOWN");
  assertCanonicalSharedId(envelope.tenant.tenant_id, "ten_", boundary);
  assertNonEmpty(envelope.tenant?.tenant_revision, boundary);
  assertNonEmpty(envelope.workspace_connection?.connection_id, boundary);
  assertCanonicalSharedId(envelope.workspace_connection.connection_id, "wsc_", boundary);
  assertNonEmpty(envelope.workspace_connection?.connection_revision, boundary);
  assertNonEmpty(envelope.workspace_connection?.workspace_id, boundary);
  assertNonEmpty(envelope.workspace_connection?.app_id, boundary);
  assertNonEmpty(envelope.actor?.principal_id, boundary);
  assertNonEmpty(envelope.slack?.event_id, boundary);
  assertNonEmpty(envelope.slack?.channel_id, boundary);
  assertNonEmpty(envelope.correlation_id, boundary);
  assertCanonicalSharedId(envelope.correlation_id, "cor_", boundary);
  assertNonEmpty(envelope.operation_id, boundary);
  assertCanonicalSharedId(envelope.operation_id, "op_", boundary);
  assertNonEmpty(envelope.idempotency_key, boundary);
  if (!/^ik1_[A-Za-z0-9_-]{43}$/.test(envelope.idempotency_key)) deny(boundary, "IDENTIFIER_FORMAT_INVALID");
  assertNonEmpty(envelope.contract_revision, boundary);
  assertNonEmpty(envelope.credential?.credential_ref, boundary);
  assertNonEmpty(envelope.issued_at, boundary);
  assertNonEmpty(envelope.expires_at, boundary);
  assertNonEmpty(envelope.placement?.deployment_id, boundary);
  assertCanonicalSharedId(envelope.placement.deployment_id, "dep_", boundary);
}

function assertFresh(envelope: UnsignedTenantContextEnvelope, boundary: BoundaryName, now: string): void {
  const issuedAt = Date.parse(envelope.issued_at);
  const expiresAt = Date.parse(envelope.expires_at);
  const observedAt = Date.parse(now);
  if (![issuedAt, expiresAt, observedAt].every(Number.isFinite)) deny(boundary, "TENANT_CONTEXT_SCHEMA_INVALID");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > TENANT_CONTEXT_MAX_TTL_SECONDS * 1_000) {
    deny(boundary, "TENANT_CONTEXT_EXPIRED");
  }
  const skew = TENANT_CONTEXT_CLOCK_SKEW_SECONDS * 1_000;
  if (issuedAt > observedAt + skew || expiresAt < observedAt - skew) deny(boundary, "TENANT_CONTEXT_EXPIRED");
}

async function assertSignature(
  envelope: TenantContextEnvelope,
  boundary: BoundaryName,
  resolveVerificationKey: (keyId: string) => Promise<CryptoKey | undefined>,
): Promise<void> {
  const integrity = envelope.integrity;
  if (!integrity || integrity.method !== "jws_detached" || integrity.algorithm !== "EdDSA") {
    deny(boundary, "TENANT_CONTEXT_SIGNATURE_INVALID");
  }
  const [protectedHeader, detachedPayload, encodedSignature, ...rest] = integrity.value.split(".");
  if (!protectedHeader || detachedPayload !== "" || !encodedSignature || rest.length > 0) {
    deny(boundary, "TENANT_CONTEXT_SIGNATURE_INVALID");
  }
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(protectedHeader))) as Record<string, unknown>;
  } catch {
    deny(boundary, "TENANT_CONTEXT_SIGNATURE_INVALID");
  }
  if (header.alg !== "EdDSA" || header.b64 !== false || !Array.isArray(header.crit)
    || !header.crit.includes("b64") || header.kid !== integrity.key_id
    || header.crit.length !== 1 || header.crit[0] !== "b64"
    || Object.keys(header).sort().join(",") !== "alg,b64,crit,kid,typ"
    || header.typ !== "application/mana-brainbase-tenant-context+jws") {
    deny(boundary, "TENANT_CONTEXT_SIGNATURE_INVALID");
  }
  const verificationKey = await resolveVerificationKey(integrity.key_id);
  if (!verificationKey) deny(boundary, "TENANT_CONTEXT_SIGNATURE_INVALID");
  const verified = await crypto.subtle.verify(
    { name: "Ed25519" },
    verificationKey,
    asArrayBuffer(base64UrlDecode(encodedSignature)),
    asArrayBuffer(signingInput(protectedHeader, unsignedEnvelope(envelope))),
  );
  if (!verified) deny(boundary, "TENANT_CONTEXT_SIGNATURE_INVALID");
}

function assertAuthoritativeSnapshot(
  envelope: TenantContextEnvelope,
  snapshot: WorkspaceConnectionSnapshot,
  boundary: BoundaryName,
): void {
  if (snapshot.status !== "active" || envelope.workspace_connection.status !== "active") {
    deny(boundary, "WORKSPACE_CONNECTION_REVOKED");
  }
  if (snapshot.tenant_id !== envelope.tenant.tenant_id) deny(boundary, "CROSS_TENANT_CANDIDATE");
  if (snapshot.connection_id !== envelope.workspace_connection.connection_id) deny(boundary, "TENANT_UNKNOWN");
  if (snapshot.connection_revision !== envelope.workspace_connection.connection_revision) {
    deny(boundary, "WORKSPACE_CONNECTION_STALE_REVISION");
  }
  if (snapshot.workspace_id !== envelope.workspace_connection.workspace_id
    || snapshot.app_id !== envelope.workspace_connection.app_id
    || snapshot.installation_id !== envelope.workspace_connection.installation_id) {
    deny(boundary, "WORKSPACE_OR_APP_MISMATCH");
  }
  if (snapshot.contract_revision !== envelope.contract_revision) deny(boundary, "WORKSPACE_CONNECTION_STALE_REVISION");
  if (snapshot.deployment_id !== envelope.placement.deployment_id) deny(boundary, "CROSS_TENANT_CANDIDATE");
  if (snapshot.profile !== envelope.placement.profile || snapshot.credential_mode !== envelope.credential.mode) {
    deny(boundary, "CROSS_TENANT_CANDIDATE");
  }
}

function assertExpectedScope(
  envelope: TenantContextEnvelope,
  expected: ExpectedTenantScope,
  boundary: BoundaryName,
): void {
  if (!envelope.audience.includes(expected.audience)) deny(boundary, "AUDIENCE_SCOPE_MISMATCH");
  if (envelope.workspace_connection.workspace_id !== expected.workspace_id
    || envelope.workspace_connection.app_id !== expected.app_id) deny(boundary, "WORKSPACE_OR_APP_MISMATCH");
  if (envelope.slack.channel_id !== expected.channel_id || envelope.slack.thread_ts !== expected.thread_ts) {
    deny(boundary, "DELIVERY_SCOPE_MISMATCH");
  }
  if (envelope.actor.principal_id !== expected.actor_principal_id) deny(boundary, "ACTOR_SCOPE_MISMATCH");
  if (!envelope.authorization.project_ids.includes(expected.project_id)) deny(boundary, "PROJECT_SCOPE_MISMATCH", {
    scope_reason: "expected_project_not_signed",
  });
  if (expected.project_ids !== undefined) {
    const signedProjectIds = [...envelope.authorization.project_ids].sort();
    const expectedProjectIds = [...expected.project_ids].sort();
    if (signedProjectIds.length !== expectedProjectIds.length
      || signedProjectIds.some((projectId, index) => projectId !== expectedProjectIds[index])) {
      deny(boundary, "PROJECT_SCOPE_MISMATCH", {
        scope_reason: "signed_project_set_mismatch",
      });
    }
  }
  if (!envelope.authorization.capability_ids.includes(expected.capability_id)) deny(boundary, "CAPABILITY_SCOPE_MISMATCH");
  if (envelope.placement.deployment_id !== expected.deployment_id) deny(boundary, "CROSS_TENANT_CANDIDATE");
}

export async function validateTenantBoundary(input: {
  boundary: BoundaryName;
  envelope: TenantContextEnvelope;
  authoritative_snapshot: WorkspaceConnectionSnapshot;
  expected_scope: ExpectedTenantScope;
  now: string;
  resolve_verification_key: (keyId: string) => Promise<CryptoKey | undefined>;
}): Promise<TenantContextEnvelope> {
  const verificationKey = await input.resolve_verification_key(input.envelope.integrity?.key_id);
  if (!verificationKey) deny(input.boundary, "TENANT_CONTEXT_SIGNATURE_INVALID");
  try {
    await validateCanonicalEnvelope(input.envelope, {
      now: input.now,
      verification_key: verificationKey,
    });
  } catch (error) {
    if (error instanceof CanonicalContractError) deny(input.boundary, error.code, error.details);
    throw error;
  }
  assertAuthoritativeSnapshot(input.envelope, input.authoritative_snapshot, input.boundary);
  assertExpectedScope(input.envelope, input.expected_scope, input.boundary);
  return input.envelope;
}
