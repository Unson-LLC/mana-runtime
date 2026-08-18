import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ContractError,
  REQUIRED_CAPABILITIES,
  canonicalize,
  createDetachedJws,
  encodeBase64Url,
  negotiateProtocol,
  validateCredentialLease,
  validateEnvelope,
  validateIdempotencyClaim,
  validateOperationReceipt,
  validateQuotaDecision,
  validateUsageEvent,
} from '../reference/wire.mjs';

const contractRoot = new URL('../', import.meta.url);
const fixtureRoot = new URL('fixtures/', contractRoot);

async function readJson(path, root = contractRoot) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'));
}

async function loadPositive() {
  return readJson('positive/canonical-flow.json', fixtureRoot);
}

function resolvePointer(object, pointer) {
  return pointer.split('/').filter(Boolean).reduce((value, key) => value[key], object);
}

function parentForPointer(object, pointer) {
  const parts = pointer.split('/').filter(Boolean);
  const key = parts.pop();
  const parent = parts.reduce((value, part) => value[part], object);
  return { parent, key };
}

function applyMutations(value, mutations) {
  const result = structuredClone(value);
  for (const mutation of mutations) {
    if (mutation.operation === 'replace_protected_header') {
      const [, empty, signature] = result.integrity.value.split('.');
      assert.equal(empty, '');
      result.integrity.value = `${encodeBase64Url(canonicalize(mutation.value))}..${signature}`;
      continue;
    }
    const { parent, key } = parentForPointer(result, mutation.path);
    if (mutation.operation === 'set') {
      parent[key] = mutation.value;
    } else if (mutation.operation === 'delete') {
      delete parent[key];
    } else if (mutation.operation === 'rename') {
      parent[mutation.to] = parent[key];
      delete parent[key];
    } else {
      assert.fail(`Unknown fixture mutation: ${mutation.operation}`);
    }
  }
  return result;
}

async function fixtureSetDigest(manifest) {
  const files = [
    manifest.test_key,
    ...manifest.positive,
    ...manifest.negative,
    ...manifest.non_applicable,
  ];
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update(Buffer.from([0]));
    hash.update(await readFile(new URL(file, fixtureRoot)));
  }
  return hash.digest('hex');
}

async function validateNegative(fixture, base, key) {
  const original = resolvePointer(base, fixture.target);
  const mutated = applyMutations(original, fixture.mutations);
  const now = base.evaluation_time;

  if (fixture.target === 'tenant_context_envelope') {
    return validateEnvelope(mutated, { now, publicJwk: key.public_jwk });
  }
  if (fixture.target === 'protocol_request') {
    return negotiateProtocol(mutated, base.protocol_response);
  }
  if (fixture.target === 'credential_lease_response') {
    return validateCredentialLease(base.credential_lease_request, mutated, { now });
  }
  if (fixture.target === 'quota_decision') {
    return validateQuotaDecision(mutated);
  }
  if (fixture.target.startsWith('usage_events/')) {
    return validateUsageEvent(mutated);
  }
  if (fixture.target === 'operation_receipt') {
    return validateOperationReceipt(mutated);
  }
  if (fixture.target.startsWith('idempotency_claims/')) {
    return validateIdempotencyClaim(mutated);
  }
  assert.fail(`Unknown fixture target: ${fixture.target}`);
}

test('RFC 8785 canonicalization and protected header are deterministic', () => {
  assert.equal(
    canonicalize({ z: 1, a: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27] }),
    '{"a":[333333333.3333333,1e+30,4.5,0.002,1e-27],"z":1}',
  );
  assert.equal(
    canonicalize({ '\ufb33': 1, '\r': 2, '1': 3, '\ud83d\ude00': 4, '\u0080': 5, '\u00f6': 6, '\u20ac': 7 }),
    '{"\\r":2,"1":3,"":5,"ö":6,"€":7,"😀":4,"דּ":1}',
  );
  assert.throws(() => canonicalize(Number.NaN), { code: 'JCS_INVALID_NUMBER' });
  assert.throws(() => canonicalize('\ud800'), { code: 'JCS_INVALID_UNICODE' });
});

test('canonical JSON Schema and TypeScript reference types cover every P0 wire object', async () => {
  const [schema, types] = await Promise.all([
    readJson('schema.json'),
    readFile(new URL('reference/types.ts', contractRoot), 'utf8'),
  ]);
  const requiredDefinitions = [
    'Revision',
    'TenantContextEnvelope',
    'ProtocolNegotiationRequest',
    'ProtocolNegotiationResponse',
    'CredentialLeaseRequest',
    'CredentialLeaseResponse',
    'QuotaDecision',
    'UsageEvent',
    'OperationReceipt',
    'IdempotencyClaim',
  ];
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$defs.Revision.pattern, '^(0|[1-9][0-9]*)$');
  for (const definition of requiredDefinitions) {
    assert.ok(schema.$defs[definition], `schema definition ${definition}`);
    assert.match(types, new RegExp(`(?:type|interface) ${definition}\\b`), `TypeScript ${definition}`);
  }
});

test('fixture manifest fingerprint is shared by producer and consumer contracts', async () => {
  const [manifest, producer, consumer] = await Promise.all([
    readJson('fixtures/manifest.json'),
    readJson('producer.contract.json'),
    readJson('consumer.contract.json'),
  ]);
  assert.equal(await fixtureSetDigest(manifest), manifest.fixture_set_sha256);
  assert.equal(producer.fixture_manifest, consumer.fixture_manifest);
  assert.equal(producer.fixture_set_sha256, manifest.fixture_set_sha256);
  assert.equal(consumer.fixture_set_sha256, manifest.fixture_set_sha256);
  assert.equal(manifest.positive.length, 1);
  assert.equal(manifest.negative.length, 21);
  assert.equal(manifest.non_applicable.length, 1);
});

test('positive canonical flow passes negotiation, JWS, lease, quota, usage, receipt, and ownership', async () => {
  const [fixture, key] = await Promise.all([loadPositive(), readJson('test-key.json', fixtureRoot)]);
  const selected = negotiateProtocol(fixture.protocol_request, fixture.protocol_response);
  assert.equal(selected, fixture.protocol_response.selected_version);
  assert.deepEqual(fixture.protocol_request.required_capabilities, REQUIRED_CAPABILITIES);
  assert.equal(
    createDetachedJws(fixture.tenant_context_envelope, key.private_jwk, key.key_id),
    fixture.tenant_context_envelope.integrity.value,
  );
  assert.equal(validateEnvelope(fixture.tenant_context_envelope, {
    now: fixture.evaluation_time,
    publicJwk: key.public_jwk,
  }), true);
  assert.equal(validateCredentialLease(
    fixture.credential_lease_request,
    fixture.credential_lease_response,
    { now: fixture.evaluation_time },
  ), true);
  assert.equal(validateQuotaDecision(fixture.quota_decision), true);
  for (const usage of fixture.usage_events) assert.equal(validateUsageEvent(usage), true);
  assert.equal(validateOperationReceipt(fixture.operation_receipt), true);
  for (const claim of fixture.idempotency_claims) assert.equal(validateIdempotencyClaim(claim), true);
  assert.deepEqual(
    fixture.usage_events.map(({ collection_state: collection, outcome }) => [collection, outcome]),
    [
      ['collected', 'succeeded'],
      ['collected', 'succeeded'],
      ['partial', 'failed'],
      ['not_collected', 'timed_out'],
    ],
  );
});

test('every negative fixture fails with its exact canonical code before a business effect', async (t) => {
  const [manifest, base, key] = await Promise.all([
    readJson('fixtures/manifest.json'),
    loadPositive(),
    readJson('test-key.json', fixtureRoot),
  ]);
  for (const file of manifest.negative) {
    await t.test(file, async () => {
      const fixture = await readJson(file, fixtureRoot);
      assert.equal(fixture.fixture_kind, 'negative');
      assert.equal(fixture.business_api_called, false);
      await assert.rejects(
        async () => validateNegative(fixture, base, key),
        (error) => error instanceof ContractError && error.code === fixture.expected_code,
      );
    });
  }
});

test('non-applicable fixture waives optional Cloud capabilities only', async () => {
  const fixture = await readJson('non-applicable/customer-managed-oss.json', fixtureRoot);
  assert.equal(fixture.fixture_kind, 'non_applicable');
  assert.equal(fixture.deployment_profile, 'customer_managed_oss');
  assert.deepEqual(fixture.still_required, REQUIRED_CAPABILITIES);
  assert.ok(fixture.optional_capabilities.every(({ status, reason }) => status === 'non_applicable' && reason));
  assert.equal(fixture.expected.mandatory_capability_waiver_count, 0);
  assert.equal(fixture.expected.silent_downgrade, false);
  assert.equal(fixture.expected.tenant_or_credential_fallback, false);
});
