import { REQUIRED_TENANT_CAPABILITIES, TENANT_PROTOCOL_ID } from "./contracts.js";
import { jcsCanonicalize } from "./jcs.js";
import { TenantBoundaryError } from "./errors.js";
import { createIdempotencyKey } from "./idempotency.js";

export const CANONICAL_FIXTURE_SET_SHA256 =
  "81c73707578ae42d6ed539aae3ac1e8eb3b0feac906e3856e73d8cdf6629d454" as const;
export const CANONICAL_SUPPORTED_RANGE = ">=1.0 <2.0" as const;
export const CANONICAL_PROTECTED_TYP = "application/mana-brainbase-tenant-context+jws" as const;

const REVISION = /^(0|[1-9][0-9]*)$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const VERSION = /^1\.[0-9]+$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const OUTCOMES = ["succeeded", "failed", "cancelled", "timed_out"] as const;
const COLLECTION_STATES = ["collected", "partial", "not_collected"] as const;
const IDEMPOTENCY_OWNER_BY_SCOPE: Readonly<Record<string, string>> = Object.freeze({
  credential_lease: "brainbase",
  quota_decision: "brainbase",
  business_effect: "brainbase",
  usage_receipt: "brainbase",
  queue_execution: "mana_runtime",
  slack_delivery: "mana_runtime",
});

export class CanonicalContractError extends TenantBoundaryError {
  constructor(code: string, details?: Readonly<Record<string, unknown>>) {
    super("canonical_consumer", code, code, details);
    this.name = "CanonicalContractError";
  }
}

function fail(code: string, details?: Readonly<Record<string, unknown>>): never {
  throw new CanonicalContractError(code, details);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("SCHEMA_INVALID", { path });
  return value as Record<string, unknown>;
}

function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = [], path = "value"):
Record<string, unknown> {
  const object = record(value, path);
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(object);
  if (required.some((key) => !(key in object)) || actual.some((key) => !allowed.has(key))) {
    fail("SCHEMA_INVALID", { path });
  }
  return object;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail("SCHEMA_INVALID", { path });
  return value;
}

function stringArray(value: unknown, path: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    fail("SCHEMA_INVALID", { path });
  }
  return value as string[];
}

function canonicalRevision(value: unknown, path: string): string {
  if (typeof value !== "string" || !REVISION.test(value)) fail("REVISION_INVALID", { path });
  return value;
}

function prefixedUlid(value: unknown, prefixes: readonly string[], path: string): string {
  const text = stringValue(value, path);
  const [prefix, suffix] = text.split("_", 2);
  if (!prefixes.includes(prefix) || !suffix || !ULID.test(suffix)) fail("SCHEMA_INVALID", { path });
  return text;
}

function timestamp(value: unknown, path: string): number {
  if (typeof value !== "string" || !value.endsWith("Z")) fail("TIME_INVALID", { path });
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail("TIME_INVALID", { path });
  return parsed;
}

function validateTimeWindow(value: Record<string, unknown>, options: {
  now: string;
  max_ttl_seconds: number;
}): void {
  const issuedAt = timestamp(value.issued_at, "issued_at");
  const expiresAt = timestamp(value.expires_at, "expires_at");
  const now = timestamp(options.now, "now");
  if (expiresAt <= issuedAt) fail("TIME_ORDER_INVALID");
  if (expiresAt - issuedAt > options.max_ttl_seconds * 1_000) fail("TTL_EXCEEDED");
  if (issuedAt > now + 30_000) fail("NOT_YET_VALID");
  if (expiresAt < now - 30_000) fail("EXPIRED");
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value: unknown): Uint8Array {
  if (typeof value !== "string" || !BASE64URL.test(value) || value.includes("=")) fail("JWS_MALFORMED");
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const decoded = Uint8Array.from(binary, (entry) => entry.charCodeAt(0));
    if (encodeBase64Url(decoded) !== value) fail("JWS_MALFORMED");
    return decoded;
  } catch (error) {
    if (error instanceof CanonicalContractError) throw error;
    fail("JWS_MALFORMED");
  }
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function canonicalUnsignedEnvelope(envelope: Record<string, unknown>): Record<string, unknown> {
  const { integrity: _integrity, ...unsigned } = envelope;
  return unsigned;
}

function validateEnvelopeShape(value: unknown): Record<string, unknown> {
  const envelope = exactKeys(value, [
    "schema_version", "protocol_id", "protocol_version", "issuer", "audience", "tenant",
    "workspace_connection", "actor", "authorization", "placement", "slack", "correlation_id",
    "operation_id", "idempotency_key", "contract_revision", "credential", "issued_at", "expires_at", "integrity",
  ], [], "tenant_context_envelope");
  if (envelope.schema_version !== "1.0" || envelope.protocol_id !== TENANT_PROTOCOL_ID
    || typeof envelope.protocol_version !== "string" || !VERSION.test(envelope.protocol_version)
    || envelope.issuer !== "brainbase") fail("SCHEMA_INVALID");
  stringArray(envelope.audience, "audience");

  const tenant = exactKeys(envelope.tenant, ["tenant_id", "tenant_revision"], [], "tenant");
  prefixedUlid(tenant.tenant_id, ["ten"], "tenant.tenant_id");
  canonicalRevision(tenant.tenant_revision, "tenant.tenant_revision");

  const connection = exactKeys(envelope.workspace_connection, [
    "connection_id", "connection_revision", "status", "provider", "installation_id", "workspace_id", "app_id",
  ], [], "workspace_connection");
  prefixedUlid(connection.connection_id, ["wsc"], "workspace_connection.connection_id");
  canonicalRevision(connection.connection_revision, "workspace_connection.connection_revision");
  if (connection.status !== "active" || connection.provider !== "slack") fail("SCHEMA_INVALID");
  for (const key of ["installation_id", "workspace_id", "app_id"]) stringValue(connection[key], `workspace_connection.${key}`);

  const actor = exactKeys(envelope.actor,
    ["principal_id", "principal_type", "authenticated_subject_id"], ["delegated_by"], "actor");
  stringValue(actor.principal_id, "actor.principal_id");
  if (actor.principal_type !== "person" && actor.principal_type !== "service") fail("SCHEMA_INVALID");
  stringValue(actor.authenticated_subject_id, "actor.authenticated_subject_id");
  if (actor.delegated_by !== undefined) stringValue(actor.delegated_by, "actor.delegated_by");

  const authorization = exactKeys(envelope.authorization,
    ["organization_ids", "project_ids", "data_scopes", "capability_ids"], [], "authorization");
  for (const key of ["organization_ids", "project_ids", "data_scopes", "capability_ids"]) {
    stringArray(authorization[key], `authorization.${key}`, true);
  }

  const placement = exactKeys(envelope.placement, ["deployment_id", "profile"], [], "placement");
  prefixedUlid(placement.deployment_id, ["dep"], "placement.deployment_id");
  if (!["shared_cloud", "dedicated_cloud", "customer_managed_oss"].includes(String(placement.profile))) {
    fail("SCHEMA_INVALID");
  }

  const slack = exactKeys(envelope.slack, ["event_id", "channel_id"],
    ["enterprise_id", "thread_ts", "requester_id"], "slack");
  for (const key of Object.keys(slack)) stringValue(slack[key], `slack.${key}`);

  prefixedUlid(envelope.correlation_id, ["cor"], "correlation_id");
  prefixedUlid(envelope.operation_id, ["op"], "operation_id");
  if (typeof envelope.idempotency_key !== "string" || !/^ik1_[A-Za-z0-9_-]{43}$/.test(envelope.idempotency_key)) {
    fail("IDEMPOTENCY_KEY_INVALID");
  }
  canonicalRevision(envelope.contract_revision, "contract_revision");

  const credential = exactKeys(envelope.credential,
    ["mode", "credential_ref", "billing_principal_id"], [], "credential");
  if (!["cloud_standard", "customer_oauth", "customer_api"].includes(String(credential.mode))) fail("SCHEMA_INVALID");
  stringValue(credential.credential_ref, "credential.credential_ref");
  stringValue(credential.billing_principal_id, "credential.billing_principal_id");

  const integrity = exactKeys(envelope.integrity,
    ["method", "algorithm", "key_id", "value"], [], "integrity");
  if (integrity.method !== "jws_detached" || integrity.algorithm !== "EdDSA") fail("JWS_PROTECTED_HEADER_INVALID");
  stringValue(integrity.key_id, "integrity.key_id");
  stringValue(integrity.value, "integrity.value");
  return envelope;
}

async function verifyDetachedJws(
  envelope: Record<string, unknown>,
  verificationKey: JsonWebKey | CryptoKey,
): Promise<void> {
  const integrity = record(envelope.integrity, "integrity");
  const parts = String(integrity.value).split(".");
  if (parts.length !== 3 || parts[1] !== "" || !parts[0] || !parts[2]) fail("JWS_MALFORMED");
  const headerBytes = decodeBase64Url(parts[0]);
  let header: Record<string, unknown>;
  let rawHeader: string;
  try {
    rawHeader = new TextDecoder("utf-8", { fatal: true }).decode(headerBytes);
    header = JSON.parse(rawHeader) as Record<string, unknown>;
  } catch {
    fail("JWS_MALFORMED");
  }
  exactKeys(header, ["alg", "b64", "crit", "kid", "typ"], [], "protected_header");
  if (header.alg !== "EdDSA" || header.b64 !== false || !Array.isArray(header.crit)
    || header.crit.length !== 1 || header.crit[0] !== "b64" || header.kid !== integrity.key_id
    || header.typ !== CANONICAL_PROTECTED_TYP || rawHeader !== jcsCanonicalize(header)) {
    fail("JWS_PROTECTED_HEADER_INVALID");
  }
  const signature = decodeBase64Url(parts[2]);
  if (signature.length !== 64) fail("JWS_MALFORMED");
  let key: CryptoKey;
  try {
    key = "type" in verificationKey
      ? verificationKey
      : await crypto.subtle.importKey("jwk", verificationKey, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    fail("TENANT_CONTEXT_SIGNATURE_INVALID");
  }
  const signingInput = new TextEncoder().encode(`${parts[0]}.${jcsCanonicalize(canonicalUnsignedEnvelope(envelope))}`);
  const valid = await crypto.subtle.verify("Ed25519", key, arrayBuffer(signature), arrayBuffer(signingInput));
  if (!valid) fail("TENANT_CONTEXT_SIGNATURE_INVALID");
}

export async function validateCanonicalEnvelope(value: unknown, options: {
  now: string;
  public_jwk?: JsonWebKey;
  verification_key?: CryptoKey;
}): Promise<true> {
  const envelope = validateEnvelopeShape(value);
  validateTimeWindow(envelope, { now: options.now, max_ttl_seconds: 300 });
  const tenant = record(envelope.tenant, "tenant");
  const connection = record(envelope.workspace_connection, "workspace_connection");
  const slack = record(envelope.slack, "slack");
  const expectedKey = await createIdempotencyKey({
    protocol_id: TENANT_PROTOCOL_ID,
    protocol_major: String(envelope.protocol_version).split(".")[0],
    tenant_id: String(tenant.tenant_id),
    connection_id: String(connection.connection_id),
    slack_event_id: String(slack.event_id),
    operation_id: String(envelope.operation_id),
  });
  if (envelope.idempotency_key !== expectedKey) fail("IDEMPOTENCY_KEY_INVALID");
  const verificationKey = options.verification_key ?? options.public_jwk;
  if (!verificationKey) fail("TENANT_CONTEXT_SIGNATURE_INVALID");
  await verifyDetachedJws(envelope, verificationKey);
  return true;
}

function assertCapabilities(value: unknown): string[] {
  const capabilities = stringArray(value, "required_capabilities");
  const required = new Set<string>(REQUIRED_TENANT_CAPABILITIES);
  if (capabilities.length !== required.size || capabilities.some((capability) => !required.has(capability))) {
    fail("PROTOCOL_CAPABILITY_UNSUPPORTED");
  }
  return capabilities;
}

function versions(value: unknown): string[] {
  const supported = stringArray(value, "supported_versions");
  if (supported.some((version) => !VERSION.test(version))) fail("PROTOCOL_VERSION_UNSUPPORTED");
  return supported;
}

export function negotiateCanonicalProtocol(requestValue: unknown, responseValue: unknown): string {
  const request = exactKeys(requestValue, [
    "message_type", "protocol_id", "supported_range", "supported_versions", "required_capabilities",
    "optional_capabilities", "deployment_id", "deployment_profile",
  ], [], "protocol_request");
  const response = exactKeys(responseValue, [
    "message_type", "protocol_id", "selected_version", "supported_range", "supported_versions",
    "required_capabilities", "optional_capabilities", "compatibility_until",
  ], [], "protocol_response");
  if (request.message_type !== "protocol_negotiation_request" || response.message_type !== "protocol_negotiation_response"
    || request.protocol_id !== TENANT_PROTOCOL_ID || response.protocol_id !== TENANT_PROTOCOL_ID
    || request.supported_range !== CANONICAL_SUPPORTED_RANGE || response.supported_range !== CANONICAL_SUPPORTED_RANGE) {
    fail("PROTOCOL_VERSION_UNSUPPORTED");
  }
  const requestVersions = versions(request.supported_versions);
  const responseVersions = new Set(versions(response.supported_versions));
  assertCapabilities(request.required_capabilities);
  assertCapabilities(response.required_capabilities);
  stringArray(request.optional_capabilities, "optional_capabilities", true);
  if (!Array.isArray(response.optional_capabilities)) fail("SCHEMA_INVALID");
  for (const entry of response.optional_capabilities) {
    const optional = exactKeys(entry, ["capability", "status"], ["reason"], "optional_capability");
    stringValue(optional.capability, "optional_capability.capability");
    if (!["supported", "unsupported", "non_applicable"].includes(String(optional.status))) fail("SCHEMA_INVALID");
    if (optional.reason !== undefined) stringValue(optional.reason, "optional_capability.reason");
  }
  prefixedUlid(request.deployment_id, ["dep"], "deployment_id");
  if (!["shared_cloud", "dedicated_cloud", "customer_managed_oss"].includes(String(request.deployment_profile))) {
    fail("SCHEMA_INVALID");
  }
  timestamp(response.compatibility_until, "compatibility_until");
  const mutual = requestVersions.filter((version) => responseVersions.has(version))
    .sort((left, right) => Number(left.split(".")[1]) - Number(right.split(".")[1]));
  if (mutual.length === 0) fail("PROTOCOL_VERSION_UNSUPPORTED");
  const selected = mutual[mutual.length - 1];
  if (response.selected_version !== selected) fail("PROTOCOL_VERSION_UNSUPPORTED");
  return selected;
}

function validateLeaseBinding(value: unknown, path: string): Record<string, unknown> {
  const binding = exactKeys(value, [
    "tenant_id", "connection_id", "connection_revision", "contract_revision", "operation_id",
    "audience", "credential_mode", "credential_ref",
  ], [], path);
  prefixedUlid(binding.tenant_id, ["ten"], `${path}.tenant_id`);
  prefixedUlid(binding.connection_id, ["wsc"], `${path}.connection_id`);
  canonicalRevision(binding.connection_revision, `${path}.connection_revision`);
  canonicalRevision(binding.contract_revision, `${path}.contract_revision`);
  prefixedUlid(binding.operation_id, ["op"], `${path}.operation_id`);
  stringValue(binding.audience, `${path}.audience`);
  if (!["cloud_standard", "customer_oauth", "customer_api"].includes(String(binding.credential_mode))) {
    fail("CREDENTIAL_LEASE_INVALID");
  }
  stringValue(binding.credential_ref, `${path}.credential_ref`);
  return binding;
}

export function validateCanonicalCredentialLease(requestValue: unknown, responseValue: unknown, options: {
  now: string;
}): true {
  let request: Record<string, unknown>;
  let response: Record<string, unknown>;
  try {
    request = exactKeys(requestValue,
      ["message_type", "protocol_version", "binding", "requested_ttl_seconds"], [], "credential_lease_request");
    response = exactKeys(responseValue, [
      "message_type", "protocol_version", "lease_id", "contract_revision", "binding", "issued_at",
      "expires_at", "max_uses", "lease_token",
    ], [], "credential_lease_response");
  } catch (error) {
    if (error instanceof CanonicalContractError && error.code === "SCHEMA_INVALID") {
      fail("CREDENTIAL_LEASE_INVALID");
    }
    throw error;
  }
  if (request.message_type !== "credential_lease_request" || response.message_type !== "credential_lease_response"
    || request.protocol_version !== "1.0" || response.protocol_version !== "1.0" || response.max_uses !== 1) {
    fail("CREDENTIAL_LEASE_INVALID");
  }
  if (!Number.isInteger(request.requested_ttl_seconds) || Number(request.requested_ttl_seconds) < 1
    || Number(request.requested_ttl_seconds) > 60) fail("CREDENTIAL_LEASE_TTL_INVALID");
  const requestBinding = validateLeaseBinding(request.binding, "credential_lease_request.binding");
  const responseBinding = validateLeaseBinding(response.binding, "credential_lease_response.binding");
  prefixedUlid(response.lease_id, ["lease"], "lease_id");
  canonicalRevision(response.contract_revision, "contract_revision");
  stringValue(response.lease_token, "lease_token");
  if (jcsCanonicalize(requestBinding) !== jcsCanonicalize(responseBinding)
    || response.contract_revision !== requestBinding.contract_revision) fail("CREDENTIAL_LEASE_BINDING_MISMATCH");
  validateTimeWindow(response, { now: options.now, max_ttl_seconds: 60 });
  if ((Date.parse(String(response.expires_at)) - Date.parse(String(response.issued_at))) / 1_000
    > Number(request.requested_ttl_seconds)) fail("CREDENTIAL_LEASE_TTL_INVALID");
  return true;
}

export function validateCanonicalQuotaDecision(value: unknown): true {
  const quota = exactKeys(value, [
    "message_type", "tenant_id", "contract_revision", "quota_revision", "decision", "limit", "used",
    "remaining", "unit", "window_started_at", "window_ends_at", "decided_at",
  ], ["failure_code"], "quota_decision");
  if (quota.message_type !== "quota_decision") fail("SCHEMA_INVALID");
  prefixedUlid(quota.tenant_id, ["ten"], "tenant_id");
  canonicalRevision(quota.contract_revision, "contract_revision");
  canonicalRevision(quota.quota_revision, "quota_revision");
  if (!["allowed", "warning", "hard_stopped", "approval_required", "unavailable"].includes(String(quota.decision))) {
    fail("QUOTA_DECISION_INVALID");
  }
  stringValue(quota.unit, "unit");
  timestamp(quota.window_started_at, "window_started_at");
  timestamp(quota.window_ends_at, "window_ends_at");
  timestamp(quota.decided_at, "decided_at");
  if (quota.failure_code !== undefined && quota.failure_code !== null) stringValue(quota.failure_code, "failure_code");
  if (quota.decision === "unavailable") {
    if (quota.limit !== null || quota.used !== null || quota.remaining !== null) fail("QUOTA_UNAVAILABLE_VALUE_INVALID");
  } else if ([quota.limit, quota.used, quota.remaining]
    .some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || entry < 0)) {
    fail("QUOTA_VALUE_INVALID");
  }
  return true;
}

function validateCollectionOutcome(value: Record<string, unknown>, prefix = "usage"): void {
  if (!COLLECTION_STATES.includes(value.collection_state as typeof COLLECTION_STATES[number])) {
    fail("COLLECTION_STATE_INVALID");
  }
  if (!OUTCOMES.includes(value.outcome as typeof OUTCOMES[number])) fail("OUTCOME_INVALID");
  if (!Array.isArray(value.unknown_fields)
    || value.unknown_fields.some((entry) => typeof entry !== "string" || entry.length === 0)) fail("SCHEMA_INVALID");
  if (value.collection_state === "not_collected" && value.quantity !== null) {
    fail("USAGE_NOT_COLLECTED_HAS_QUANTITY");
  }
  if (value.collection_state === "partial" && value.unknown_fields.length === 0) {
    fail("USAGE_PARTIAL_UNKNOWN_FIELDS_REQUIRED");
  }
  if (value.collection_state === "collected") {
    if (typeof value.quantity !== "number" || !Number.isFinite(value.quantity) || value.quantity < 0) {
      fail("USAGE_COLLECTED_QUANTITY_REQUIRED");
    }
    if (value.unknown_fields.length !== 0) fail("USAGE_COLLECTED_UNKNOWN_FIELDS_FORBIDDEN");
    if (value.quantity === 0 && value.failure_code !== "NO_DATA") fail("USAGE_ZERO_REQUIRES_NO_DATA");
  }
  if (prefix === "usage" && value.quantity !== null
    && (typeof value.quantity !== "number" || !Number.isFinite(value.quantity) || value.quantity < 0)) {
    fail("USAGE_COLLECTED_QUANTITY_REQUIRED");
  }
}

export function validateCanonicalUsageEvent(value: unknown): true {
  const usage = exactKeys(value, [
    "message_type", "usage_event_id", "protocol_version", "tenant_id", "connection_id", "connection_revision",
    "contract_revision", "deployment_id", "correlation_id", "operation_id", "idempotency_key", "kind",
    "quantity", "unit", "collection_state", "outcome", "failure_code", "unknown_fields", "observed_at",
  ], [], "usage_event");
  if (usage.message_type !== "usage_event" || usage.protocol_version !== "1.0") fail("SCHEMA_INVALID");
  prefixedUlid(usage.usage_event_id, ["usage"], "usage_event_id");
  prefixedUlid(usage.tenant_id, ["ten"], "tenant_id");
  prefixedUlid(usage.connection_id, ["wsc"], "connection_id");
  canonicalRevision(usage.connection_revision, "connection_revision");
  canonicalRevision(usage.contract_revision, "contract_revision");
  prefixedUlid(usage.deployment_id, ["dep"], "deployment_id");
  prefixedUlid(usage.correlation_id, ["cor"], "correlation_id");
  prefixedUlid(usage.operation_id, ["op"], "operation_id");
  if (typeof usage.idempotency_key !== "string" || !/^ik1_[A-Za-z0-9_-]{43}$/.test(usage.idempotency_key)) {
    fail("IDEMPOTENCY_KEY_INVALID");
  }
  stringValue(usage.kind, "kind");
  stringValue(usage.unit, "unit");
  if (usage.failure_code !== null) stringValue(usage.failure_code, "failure_code");
  timestamp(usage.observed_at, "observed_at");
  validateCollectionOutcome(usage);
  return true;
}

export function validateCanonicalOperationReceipt(value: unknown): true {
  const receipt = exactKeys(value, [
    "message_type", "receipt_id", "protocol_version", "tenant_id", "connection_id", "connection_revision",
    "contract_revision", "deployment_id", "correlation_id", "operation_ids", "idempotency_keys",
    "actor_principal_id", "project_id", "capability_id", "quota_decision", "credential_mode",
    "collection_state", "outcome", "failure_code", "usage_event_ids", "reply", "completed_at",
  ], [], "operation_receipt");
  if (receipt.message_type !== "operation_receipt" || receipt.protocol_version !== "1.0") fail("SCHEMA_INVALID");
  prefixedUlid(receipt.receipt_id, ["receipt"], "receipt_id");
  prefixedUlid(receipt.tenant_id, ["ten"], "tenant_id");
  prefixedUlid(receipt.connection_id, ["wsc"], "connection_id");
  canonicalRevision(receipt.connection_revision, "connection_revision");
  canonicalRevision(receipt.contract_revision, "contract_revision");
  prefixedUlid(receipt.deployment_id, ["dep"], "deployment_id");
  prefixedUlid(receipt.correlation_id, ["cor"], "correlation_id");
  for (const operationId of stringArray(receipt.operation_ids, "operation_ids")) prefixedUlid(operationId, ["op"], "operation_ids");
  for (const key of stringArray(receipt.idempotency_keys, "idempotency_keys")) {
    if (!/^ik1_[A-Za-z0-9_-]{43}$/.test(key)) fail("IDEMPOTENCY_KEY_INVALID");
  }
  stringValue(receipt.actor_principal_id, "actor_principal_id");
  if (receipt.project_id !== null) stringValue(receipt.project_id, "project_id");
  stringValue(receipt.capability_id, "capability_id");
  if (!["allowed", "warning", "hard_stopped", "approval_required", "unavailable"].includes(String(receipt.quota_decision))) {
    fail("QUOTA_DECISION_INVALID");
  }
  if (!["cloud_standard", "customer_oauth", "customer_api"].includes(String(receipt.credential_mode))) fail("SCHEMA_INVALID");
  if (!COLLECTION_STATES.includes(receipt.collection_state as typeof COLLECTION_STATES[number])) fail("COLLECTION_STATE_INVALID");
  if (!OUTCOMES.includes(receipt.outcome as typeof OUTCOMES[number])) fail("OUTCOME_INVALID");
  if (receipt.failure_code !== null) stringValue(receipt.failure_code, "failure_code");
  for (const usageId of stringArray(receipt.usage_event_ids, "usage_event_ids")) {
    prefixedUlid(usageId, ["usage"], "usage_event_ids");
  }
  const reply = exactKeys(receipt.reply, ["state", "reply_count", "legacy_reply_count"], ["slack_reply_ts"], "reply");
  if (!["not_attempted", "delivered", "failed", "unknown"].includes(String(reply.state))
    || (reply.reply_count !== 0 && reply.reply_count !== 1) || reply.legacy_reply_count !== 0) {
    fail("REPLY_OWNERSHIP_INVALID");
  }
  if (reply.slack_reply_ts !== undefined) stringValue(reply.slack_reply_ts, "reply.slack_reply_ts");
  timestamp(receipt.completed_at, "completed_at");
  return true;
}

export async function validateCanonicalIdempotencyClaim(value: unknown): Promise<true> {
  const claim = exactKeys(value, [
    "message_type", "owner", "scope", "tenant_id", "connection_id", "slack_event_id", "operation_id",
    "idempotency_key", "context_hash", "payload_hash", "state", "retention_until",
  ], [], "idempotency_claim");
  if (claim.message_type !== "idempotency_claim") fail("SCHEMA_INVALID");
  const expectedOwner = IDEMPOTENCY_OWNER_BY_SCOPE[String(claim.scope)];
  if (!expectedOwner || claim.owner !== expectedOwner) fail("IDEMPOTENCY_OWNER_INVALID");
  prefixedUlid(claim.tenant_id, ["ten"], "tenant_id");
  prefixedUlid(claim.connection_id, ["wsc"], "connection_id");
  stringValue(claim.slack_event_id, "slack_event_id");
  prefixedUlid(claim.operation_id, ["op"], "operation_id");
  for (const field of ["context_hash", "payload_hash"] as const) {
    if (typeof claim[field] !== "string" || !/^sha256:[a-f0-9]{64}$/.test(claim[field])) fail("SCHEMA_INVALID");
  }
  if (!["pending", "claimed", "succeeded", "failed_terminal"].includes(String(claim.state))) fail("SCHEMA_INVALID");
  timestamp(claim.retention_until, "retention_until");
  const expectedKey = await createIdempotencyKey({
    protocol_id: TENANT_PROTOCOL_ID,
    protocol_major: "1",
    tenant_id: String(claim.tenant_id),
    connection_id: String(claim.connection_id),
    slack_event_id: String(claim.slack_event_id),
    operation_id: String(claim.operation_id),
  });
  if (claim.idempotency_key !== expectedKey) fail("IDEMPOTENCY_KEY_INVALID");
  return true;
}

export function validateCanonicalNonApplicable(value: unknown): { mandatory_capability_waiver_count: 0 } {
  const fixture = exactKeys(value, [
    "fixture_id", "fixture_kind", "description", "deployment_profile", "optional_capabilities",
    "still_required", "expected",
  ], [], "non_applicable_fixture");
  if (fixture.fixture_kind !== "non_applicable" || fixture.deployment_profile !== "customer_managed_oss") fail("SCHEMA_INVALID");
  assertCapabilities(fixture.still_required);
  if (!Array.isArray(fixture.optional_capabilities)) fail("SCHEMA_INVALID");
  for (const entry of fixture.optional_capabilities) {
    const optional = exactKeys(entry, ["capability", "status", "reason"], [], "optional_capability");
    if (optional.status !== "non_applicable" || typeof optional.reason !== "string" || optional.reason.length === 0
      || REQUIRED_TENANT_CAPABILITIES.includes(optional.capability as typeof REQUIRED_TENANT_CAPABILITIES[number])) {
      fail("PROTOCOL_CAPABILITY_UNSUPPORTED");
    }
  }
  const expected = exactKeys(fixture.expected, [
    "contract_result", "mandatory_capability_waiver_count", "silent_downgrade", "tenant_or_credential_fallback",
  ], [], "expected");
  if (expected.contract_result !== "accepted" || expected.mandatory_capability_waiver_count !== 0
    || expected.silent_downgrade !== false || expected.tenant_or_credential_fallback !== false) {
    fail("FALLBACK_FORBIDDEN");
  }
  return { mandatory_capability_waiver_count: 0 };
}

function assertSameScope(envelope: Record<string, unknown>, value: Record<string, unknown>): void {
  const tenant = record(envelope.tenant, "tenant");
  const connection = record(envelope.workspace_connection, "workspace_connection");
  const placement = record(envelope.placement, "placement");
  if (("tenant_id" in value && value.tenant_id !== tenant.tenant_id)
    || ("connection_id" in value && value.connection_id !== connection.connection_id)
    || ("connection_revision" in value && value.connection_revision !== connection.connection_revision)
    || ("contract_revision" in value && value.contract_revision !== envelope.contract_revision)
    || ("deployment_id" in value && value.deployment_id !== placement.deployment_id)
    || ("correlation_id" in value && value.correlation_id !== envelope.correlation_id)) {
    fail("CROSS_TENANT_CANDIDATE");
  }
}

export async function validateCanonicalConsumerFlow(value: unknown, options: {
  public_jwk: JsonWebKey;
}): Promise<true> {
  const flow = exactKeys(value, [
    "fixture_id", "fixture_kind", "description", "evaluation_time", "key_id", "protocol_request",
    "protocol_response", "tenant_context_envelope", "credential_lease_request", "credential_lease_response",
    "quota_decision", "usage_events", "operation_receipt", "idempotency_claims",
  ], [], "canonical_flow");
  if (flow.fixture_kind !== "positive") fail("SCHEMA_INVALID");
  negotiateCanonicalProtocol(flow.protocol_request, flow.protocol_response);
  await validateCanonicalEnvelope(flow.tenant_context_envelope, {
    now: String(flow.evaluation_time),
    public_jwk: options.public_jwk,
  });
  validateCanonicalCredentialLease(flow.credential_lease_request, flow.credential_lease_response, {
    now: String(flow.evaluation_time),
  });
  validateCanonicalQuotaDecision(flow.quota_decision);
  if (!Array.isArray(flow.usage_events) || flow.usage_events.length === 0) fail("SCHEMA_INVALID");
  for (const event of flow.usage_events) validateCanonicalUsageEvent(event);
  validateCanonicalOperationReceipt(flow.operation_receipt);
  if (!Array.isArray(flow.idempotency_claims) || flow.idempotency_claims.length === 0) fail("SCHEMA_INVALID");
  for (const claim of flow.idempotency_claims) await validateCanonicalIdempotencyClaim(claim);

  const envelope = record(flow.tenant_context_envelope, "tenant_context_envelope");
  const request = record(flow.credential_lease_request, "credential_lease_request");
  const binding = record(request.binding, "credential_lease_request.binding");
  assertSameScope(envelope, binding);
  assertSameScope(envelope, record(flow.quota_decision, "quota_decision"));
  for (const event of flow.usage_events) assertSameScope(envelope, record(event, "usage_event"));
  assertSameScope(envelope, record(flow.operation_receipt, "operation_receipt"));
  return true;
}
