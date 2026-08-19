import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
  verify as ed25519Verify,
} from 'node:crypto';

export const PROTOCOL_ID = 'mana-brainbase-tenant-context';
export const SUPPORTED_RANGE = '>=1.0 <2.0';
export const MAX_ENVELOPE_TTL_SECONDS = 300;
export const MAX_LEASE_TTL_SECONDS = 60;
export const MAX_CLOCK_SKEW_SECONDS = 30;
export const PROTECTED_TYP = 'application/mana-brainbase-tenant-context+jws';
export const REQUIRED_CAPABILITIES = Object.freeze([
  'signed_tenant_context',
  'connection_revision_recheck',
  'tenant_scoped_authorization',
  'credential_broker_v1',
  'usage_receipt_v1',
  'idempotent_effects_v1',
  'container_sanitization_v1',
]);

const REVISION_PATTERN = /^(0|[1-9][0-9]*)$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const IDEMPOTENCY_OWNER_BY_SCOPE = Object.freeze({
  credential_lease: 'brainbase',
  quota_decision: 'brainbase',
  business_effect: 'brainbase',
  usage_receipt: 'brainbase',
  queue_execution: 'mana_runtime',
  slack_delivery: 'mana_runtime',
});

export class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ContractError(code, message);
}

function assertObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('SCHEMA_INVALID', `${path} must be an object`);
  }
}

function assertExactKeys(value, expected, path) {
  assertObject(value, path);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('SCHEMA_INVALID', `${path} keys must be exactly ${wanted.join(',')}`);
  }
}

function assertRequiredAllowedKeys(value, required, optional, path) {
  assertObject(value, path);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    fail(
      'SCHEMA_INVALID',
      `${path} has missing keys [${missing.join(',')}] and unexpected keys [${unexpected.join(',')}]`,
    );
  }
}

function assertNoLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail('JCS_INVALID_UNICODE', 'RFC 8785 forbids lone UTF-16 surrogates');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('JCS_INVALID_UNICODE', 'RFC 8785 forbids lone UTF-16 surrogates');
    }
  }
}

/** RFC 8785 JSON Canonicalization Scheme for I-JSON values. */
export function canonicalize(value) {
  const seen = new Set();

  function serialize(input) {
    if (input === null) return 'null';
    if (typeof input === 'boolean') return input ? 'true' : 'false';
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) fail('JCS_INVALID_NUMBER', 'JCS requires finite numbers');
      return JSON.stringify(input);
    }
    if (typeof input === 'string') {
      assertNoLoneSurrogate(input);
      return JSON.stringify(input);
    }
    if (typeof input !== 'object') {
      fail('JCS_INVALID_VALUE', `JCS cannot encode ${typeof input}`);
    }
    if (seen.has(input)) fail('JCS_INVALID_VALUE', 'JCS cannot encode cyclic values');
    seen.add(input);
    let result;
    if (Array.isArray(input)) {
      result = `[${input.map((entry) => serialize(entry)).join(',')}]`;
    } else {
      const entries = Object.keys(input)
        .sort()
        .map((key) => {
          assertNoLoneSurrogate(key);
          return `${JSON.stringify(key)}:${serialize(input[key])}`;
        });
      result = `{${entries.join(',')}}`;
    }
    seen.delete(input);
    return result;
  }

  return serialize(value);
}

export function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

export function decodeBase64Url(value) {
  if (!BASE64URL_PATTERN.test(value) || value.includes('=')) {
    fail('JWS_MALFORMED', 'base64url must be unpadded and canonical');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    fail('JWS_MALFORMED', 'base64url is not canonical');
  }
  return decoded;
}

export function protectedHeader(keyId) {
  return {
    alg: 'EdDSA',
    b64: false,
    crit: ['b64'],
    kid: keyId,
    typ: PROTECTED_TYP,
  };
}

export function unsignedEnvelope(envelope) {
  assertObject(envelope, 'envelope');
  const { integrity: _integrity, ...unsigned } = envelope;
  return unsigned;
}

export function signingInput(envelope, protected64) {
  return Buffer.concat([
    Buffer.from(`${protected64}.`, 'ascii'),
    Buffer.from(canonicalize(unsignedEnvelope(envelope)), 'utf8'),
  ]);
}

export function createDetachedJws(envelope, privateJwk, keyId) {
  const header64 = encodeBase64Url(canonicalize(protectedHeader(keyId)));
  const signature = ed25519Sign(
    null,
    signingInput(envelope, header64),
    createPrivateKey({ key: privateJwk, format: 'jwk' }),
  );
  return `${header64}..${encodeBase64Url(signature)}`;
}

export function parseDetachedJws(value, expectedKeyId) {
  if (typeof value !== 'string') fail('JWS_MALFORMED', 'detached JWS must be a string');
  const parts = value.split('.');
  if (parts.length !== 3 || parts[1] !== '' || !parts[0] || !parts[2]) {
    fail('JWS_MALFORMED', 'detached JWS must be protected64..signature64');
  }
  let header;
  const headerBytes = decodeBase64Url(parts[0]);
  try {
    header = JSON.parse(headerBytes.toString('utf8'));
  } catch {
    fail('JWS_MALFORMED', 'protected header is not JSON');
  }
  assertExactKeys(header, ['alg', 'b64', 'crit', 'kid', 'typ'], 'protected header');
  if (
    header.alg !== 'EdDSA'
    || header.b64 !== false
    || !Array.isArray(header.crit)
    || header.crit.length !== 1
    || header.crit[0] !== 'b64'
    || header.kid !== expectedKeyId
    || header.typ !== PROTECTED_TYP
  ) {
    fail('JWS_PROTECTED_HEADER_INVALID', 'protected header does not match the canonical five-field contract');
  }
  if (headerBytes.toString('utf8') !== canonicalize(header)) {
    fail('JWS_PROTECTED_HEADER_INVALID', 'protected header is not RFC 8785 canonical JSON');
  }
  const signature = decodeBase64Url(parts[2]);
  if (signature.length !== 64) fail('JWS_MALFORMED', 'Ed25519 signature must be 64 bytes');
  return { header, protected64: parts[0], signature };
}

export function verifyDetachedJws(envelope, publicJwk) {
  const keyId = envelope?.integrity?.key_id;
  const parsed = parseDetachedJws(envelope?.integrity?.value, keyId);
  const valid = ed25519Verify(
    null,
    signingInput(envelope, parsed.protected64),
    createPublicKey({ key: publicJwk, format: 'jwk' }),
    parsed.signature,
  );
  if (!valid) fail('TENANT_CONTEXT_SIGNATURE_INVALID', 'Ed25519 signature verification failed');
  return true;
}

export function assertRevision(value, path = 'revision') {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) {
    fail('REVISION_INVALID', `${path} must be a canonical decimal string`);
  }
}

function timestampMs(value, path) {
  if (typeof value !== 'string' || !value.endsWith('Z')) {
    fail('TIME_INVALID', `${path} must be an RFC 3339 UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('TIME_INVALID', `${path} is not a valid timestamp`);
  return parsed;
}

export function validateTimeWindow({ issued_at: issuedAt, expires_at: expiresAt }, {
  now,
  maxTtlSeconds,
  maxClockSkewSeconds = MAX_CLOCK_SKEW_SECONDS,
}) {
  const issued = timestampMs(issuedAt, 'issued_at');
  const expires = timestampMs(expiresAt, 'expires_at');
  const nowMs = now instanceof Date ? now.getTime() : timestampMs(now, 'now');
  if (expires <= issued) fail('TIME_ORDER_INVALID', 'expires_at must be later than issued_at');
  if (expires - issued > maxTtlSeconds * 1000) {
    fail('TTL_EXCEEDED', `TTL exceeds ${maxTtlSeconds} seconds`);
  }
  if (issued > nowMs + maxClockSkewSeconds * 1000) {
    fail('NOT_YET_VALID', 'issued_at is beyond the allowed clock skew');
  }
  if (expires < nowMs - maxClockSkewSeconds * 1000) {
    fail('EXPIRED', 'expires_at is beyond the allowed clock skew');
  }
  return true;
}

function uint32LengthPrefixed(value) {
  const encoded = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.length);
  return Buffer.concat([length, encoded]);
}

export function deriveIdempotencyKey({
  protocol_id: protocolId,
  protocol_major: protocolMajor,
  tenant_id: tenantId,
  connection_id: connectionId,
  slack_event_id: slackEventId,
  operation_id: operationId,
}) {
  const digest = createHash('sha256')
    .update(Buffer.concat([
      uint32LengthPrefixed(protocolId),
      uint32LengthPrefixed(String(protocolMajor)),
      uint32LengthPrefixed(tenantId),
      uint32LengthPrefixed(connectionId),
      uint32LengthPrefixed(slackEventId),
      uint32LengthPrefixed(operationId),
    ]))
    .digest('base64url');
  return `ik1_${digest}`;
}

function compareVersion(a, b) {
  const [majorA, minorA] = a.split('.').map(Number);
  const [majorB, minorB] = b.split('.').map(Number);
  return majorA - majorB || minorA - minorB;
}

function assertNegotiationShape(message, expectedType) {
  if (message?.message_type !== expectedType || message.protocol_id !== PROTOCOL_ID) {
    fail('PROTOCOL_VERSION_UNSUPPORTED', 'protocol identity or message type is unsupported');
  }
  if (message.supported_range !== SUPPORTED_RANGE || !Array.isArray(message.supported_versions)) {
    fail('PROTOCOL_VERSION_UNSUPPORTED', 'supported range and versions are required');
  }
  if (!Array.isArray(message.required_capabilities)) {
    fail('PROTOCOL_CAPABILITY_UNSUPPORTED', 'required capabilities are missing');
  }
}

export function negotiateProtocol(request, local) {
  assertNegotiationShape(request, 'protocol_negotiation_request');
  if (local.protocol_id !== PROTOCOL_ID || local.supported_range !== SUPPORTED_RANGE) {
    fail('PROTOCOL_VERSION_UNSUPPORTED', 'local protocol range is incompatible');
  }
  const localVersions = new Set(local.supported_versions);
  const mutual = request.supported_versions
    .filter((version) => version.startsWith('1.') && localVersions.has(version))
    .sort(compareVersion);
  if (mutual.length === 0) {
    fail('PROTOCOL_VERSION_UNSUPPORTED', 'no mutually supported same-major version');
  }
  const localCapabilities = new Set(local.required_capabilities);
  const missing = request.required_capabilities.filter((capability) => !localCapabilities.has(capability));
  if (missing.length > 0) {
    fail('PROTOCOL_CAPABILITY_UNSUPPORTED', `unsupported required capabilities: ${missing.join(',')}`);
  }
  for (const capability of REQUIRED_CAPABILITIES) {
    if (!request.required_capabilities.includes(capability) || !localCapabilities.has(capability)) {
      fail('PROTOCOL_CAPABILITY_UNSUPPORTED', `canonical required capability missing: ${capability}`);
    }
  }
  return mutual.at(-1);
}

export function validateEnvelope(envelope, { now, publicJwk } = {}) {
  assertRequiredAllowedKeys(envelope, [
    'schema_version',
    'protocol_id',
    'protocol_version',
    'issuer',
    'audience',
    'tenant',
    'workspace_connection',
    'actor',
    'authorization',
    'placement',
    'slack',
    'correlation_id',
    'operation_id',
    'idempotency_key',
    'contract_revision',
    'credential',
    'issued_at',
    'expires_at',
    'integrity',
  ], [], 'envelope');
  assertExactKeys(envelope.integrity, ['method', 'algorithm', 'key_id', 'value'], 'envelope.integrity');
  assertRevision(envelope?.tenant?.tenant_revision, 'tenant.tenant_revision');
  assertRevision(envelope?.workspace_connection?.connection_revision, 'workspace_connection.connection_revision');
  assertRevision(envelope?.contract_revision, 'contract_revision');
  if (
    envelope.schema_version !== '1.0'
    || envelope.protocol_id !== PROTOCOL_ID
    || !/^1\.[0-9]+$/.test(envelope.protocol_version)
    || envelope.issuer !== 'brainbase'
  ) {
    fail('SCHEMA_INVALID', 'envelope protocol constants are invalid');
  }
  if (
    envelope.integrity?.method !== 'jws_detached'
    || envelope.integrity?.algorithm !== 'EdDSA'
  ) {
    fail('JWS_PROTECTED_HEADER_INVALID', 'integrity metadata is invalid');
  }
  validateTimeWindow(envelope, {
    now,
    maxTtlSeconds: MAX_ENVELOPE_TTL_SECONDS,
  });
  const expectedKey = deriveIdempotencyKey({
    protocol_id: envelope.protocol_id,
    protocol_major: envelope.protocol_version.split('.')[0],
    tenant_id: envelope.tenant.tenant_id,
    connection_id: envelope.workspace_connection.connection_id,
    slack_event_id: envelope.slack.event_id,
    operation_id: envelope.operation_id,
  });
  if (envelope.idempotency_key !== expectedKey) {
    fail('IDEMPOTENCY_KEY_INVALID', 'idempotency key does not match the canonical LP formula');
  }
  if (publicJwk) verifyDetachedJws(envelope, publicJwk);
  return true;
}

export function validateCredentialLease(request, response, { now } = {}) {
  if (request?.message_type !== 'credential_lease_request') {
    fail('CREDENTIAL_LEASE_INVALID', 'credential lease request message type is invalid');
  }
  if (!Number.isInteger(request.requested_ttl_seconds) || request.requested_ttl_seconds < 1 || request.requested_ttl_seconds > 60) {
    fail('CREDENTIAL_LEASE_TTL_INVALID', 'requested TTL must be an integer from 1 through 60');
  }
  if (response?.message_type !== 'credential_lease_response' || response.max_uses !== 1) {
    fail('CREDENTIAL_LEASE_INVALID', 'response must use lease_id and max_uses=1');
  }
  assertRevision(request.binding?.connection_revision, 'binding.connection_revision');
  assertRevision(request.binding?.contract_revision, 'binding.contract_revision');
  assertRevision(response.contract_revision, 'response.contract_revision');
  if (
    canonicalize(request.binding) !== canonicalize(response.binding)
    || response.contract_revision !== request.binding.contract_revision
  ) {
    fail('CREDENTIAL_LEASE_BINDING_MISMATCH', 'lease binding or contract revision changed');
  }
  validateTimeWindow(response, { now, maxTtlSeconds: MAX_LEASE_TTL_SECONDS });
  const ttl = (Date.parse(response.expires_at) - Date.parse(response.issued_at)) / 1000;
  if (ttl > request.requested_ttl_seconds) {
    fail('CREDENTIAL_LEASE_TTL_INVALID', 'issued lease exceeds requested TTL');
  }
  return true;
}

export function validateUsageEvent(event) {
  assertRequiredAllowedKeys(event, [
    'message_type',
    'usage_event_id',
    'protocol_version',
    'tenant_id',
    'connection_id',
    'connection_revision',
    'contract_revision',
    'deployment_id',
    'correlation_id',
    'operation_id',
    'idempotency_key',
    'kind',
    'quantity',
    'unit',
    'collection_state',
    'outcome',
    'failure_code',
    'unknown_fields',
    'observed_at',
  ], [], 'usage_event');
  if (event.message_type !== 'usage_event') {
    fail('SCHEMA_INVALID', 'usage event message type is invalid');
  }
  assertRevision(event?.connection_revision, 'connection_revision');
  assertRevision(event?.contract_revision, 'contract_revision');
  if (!['collected', 'partial', 'not_collected'].includes(event?.collection_state)) {
    fail('COLLECTION_STATE_INVALID', 'collection_state is invalid');
  }
  if (!['succeeded', 'failed', 'cancelled', 'timed_out'].includes(event?.outcome)) {
    fail('OUTCOME_INVALID', 'outcome is invalid');
  }
  if (event.collection_state === 'not_collected' && event.quantity !== null) {
    fail('USAGE_NOT_COLLECTED_HAS_QUANTITY', 'not_collected quantity must be null');
  }
  if (event.collection_state === 'partial' && (!Array.isArray(event.unknown_fields) || event.unknown_fields.length === 0)) {
    fail('USAGE_PARTIAL_UNKNOWN_FIELDS_REQUIRED', 'partial usage must list unknown_fields');
  }
  if (event.collection_state === 'collected') {
    if (typeof event.quantity !== 'number' || event.quantity < 0) {
      fail('USAGE_COLLECTED_QUANTITY_REQUIRED', 'collected usage requires a non-negative quantity');
    }
    if (!Array.isArray(event.unknown_fields) || event.unknown_fields.length !== 0) {
      fail('USAGE_COLLECTED_UNKNOWN_FIELDS_FORBIDDEN', 'collected usage has no unknown_fields');
    }
    if (event.quantity === 0 && event.failure_code !== 'NO_DATA') {
      fail('USAGE_ZERO_REQUIRES_NO_DATA', 'a collected zero must use failure_code NO_DATA');
    }
  }
  return true;
}

export function validateQuotaDecision(decision) {
  if (decision?.message_type !== 'quota_decision') {
    fail('SCHEMA_INVALID', 'quota decision message type is invalid');
  }
  assertRevision(decision.contract_revision, 'contract_revision');
  assertRevision(decision.quota_revision, 'quota_revision');
  if (!['allowed', 'warning', 'hard_stopped', 'approval_required', 'unavailable'].includes(decision.decision)) {
    fail('QUOTA_DECISION_INVALID', 'quota decision value is invalid');
  }
  if (decision.decision === 'unavailable') {
    if (decision.limit !== null || decision.used !== null || decision.remaining !== null) {
      fail('QUOTA_UNAVAILABLE_VALUE_INVALID', 'unavailable quota values must remain null');
    }
  } else if ([decision.limit, decision.used, decision.remaining].some((value) => typeof value !== 'number' || value < 0)) {
    fail('QUOTA_VALUE_INVALID', 'available quota values must be non-negative numbers');
  }
  return true;
}

export function validateOperationReceipt(receipt) {
  assertRequiredAllowedKeys(receipt, [
    'message_type',
    'receipt_id',
    'protocol_version',
    'tenant_id',
    'connection_id',
    'connection_revision',
    'contract_revision',
    'deployment_id',
    'correlation_id',
    'operation_ids',
    'idempotency_keys',
    'actor_principal_id',
    'project_id',
    'capability_id',
    'quota_decision',
    'credential_mode',
    'collection_state',
    'outcome',
    'failure_code',
    'usage_event_ids',
    'reply',
    'completed_at',
  ], [], 'operation_receipt');
  if (receipt?.message_type !== 'operation_receipt') {
    fail('SCHEMA_INVALID', 'operation receipt message type is invalid');
  }
  assertRequiredAllowedKeys(
    receipt.reply,
    ['state', 'reply_count', 'legacy_reply_count'],
    ['slack_reply_ts'],
    'operation_receipt.reply',
  );
  assertRevision(receipt.connection_revision, 'connection_revision');
  assertRevision(receipt.contract_revision, 'contract_revision');
  if (!['collected', 'partial', 'not_collected'].includes(receipt.collection_state)) {
    fail('COLLECTION_STATE_INVALID', 'receipt collection_state is invalid');
  }
  if (!['succeeded', 'failed', 'cancelled', 'timed_out'].includes(receipt.outcome)) {
    fail('OUTCOME_INVALID', 'receipt outcome is invalid');
  }
  if (
    !receipt.reply
    || !Number.isInteger(receipt.reply.reply_count)
    || receipt.reply.reply_count < 0
    || receipt.reply.reply_count > 1
    || receipt.reply.legacy_reply_count !== 0
  ) {
    fail('REPLY_OWNERSHIP_INVALID', 'receipt must prove at most one canonical reply and zero legacy replies');
  }
  return true;
}

export function validateIdempotencyClaim(claim) {
  assertRequiredAllowedKeys(claim, [
    'message_type',
    'owner',
    'scope',
    'tenant_id',
    'connection_id',
    'slack_event_id',
    'operation_id',
    'idempotency_key',
    'context_hash',
    'payload_hash',
    'state',
    'retention_until',
  ], [], 'idempotency_claim');
  if (claim.message_type !== 'idempotency_claim') {
    fail('SCHEMA_INVALID', 'idempotency claim message type is invalid');
  }
  const expectedOwner = IDEMPOTENCY_OWNER_BY_SCOPE[claim?.scope];
  if (!expectedOwner || claim.owner !== expectedOwner) {
    fail('IDEMPOTENCY_OWNER_INVALID', 'claim scope is assigned to the wrong canonical owner');
  }
  const expectedKey = deriveIdempotencyKey({
    protocol_id: PROTOCOL_ID,
    protocol_major: '1',
    tenant_id: claim.tenant_id,
    connection_id: claim.connection_id,
    slack_event_id: claim.slack_event_id,
    operation_id: claim.operation_id,
  });
  if (claim.idempotency_key !== expectedKey) {
    fail('IDEMPOTENCY_KEY_INVALID', 'claim key does not match the canonical LP formula');
  }
  return true;
}
