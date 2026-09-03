import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('./', import.meta.url);
const contractRoot = new URL('../../../contracts/mana-brainbase-tenant-context/v1/', root);

async function readJson(file) {
  return JSON.parse(await readFile(new URL(file, root), 'utf8'));
}

test('横断契約の固定決定、受入条件、fixture、fingerprintが一致する', async () => {
  const [spec, positive, negative, nonApplicable, fingerprint, schema, manifest, producer, consumer] = await Promise.all([
    readJson('draft.json'),
    readJson('fixtures/positive.json'),
    readJson('fixtures/negative.json'),
    readJson('fixtures/non-applicable.json'),
    readJson('fingerprint.json'),
    readJson(new URL('schema.json', contractRoot)),
    readJson(new URL('fixtures/manifest.json', contractRoot)),
    readJson(new URL('producer.contract.json', contractRoot)),
    readJson(new URL('consumer.contract.json', contractRoot)),
  ]);

  const expectedAcceptanceCriteria = Array.from(
    { length: 12 },
    (_, index) => `AC-${String(index + 1).padStart(3, '0')}`,
  );

  assert.equal(spec.cross_lane_decision_table.length, 9);
  assert.ok(spec.cross_lane_decision_table.every((decision) => decision.status === 'fixed'));
  assert.deepEqual(spec.open_questions, []);
  assert.equal(spec.clauses.length, 12);
  assert.deepEqual(
    spec.acceptance_criteria_mapping.map((mapping) => mapping.ac_id).sort(),
    expectedAcceptanceCriteria,
  );
  assert.deepEqual(
    [positive.fixture_kind, negative.fixture_kind, nonApplicable.fixture_kind],
    ['positive', 'negative', 'non_applicable'],
  );
  assert.equal(spec.common_contract.tenant_context_envelope.time_validity.ttl_seconds_maximum, 300);
  assert.equal(spec.common_contract.workspace_connection.revision_type, 'canonical unsigned decimal string matching ^(0|[1-9][0-9]*)$ and monotonically increasing per connection_id');
  assert.deepEqual(
    spec.common_contract.tenant_context_envelope.signature.protected_headers,
    {
      alg: 'EdDSA',
      b64: false,
      crit: ['b64'],
      kid: 'integrity.key_id',
      typ: 'application/mana-brainbase-tenant-context+jws',
      additional_headers: 'forbidden',
    },
  );
  assert.equal(spec.implementation_start_gate.status, 'BLOCKED');
  assert.equal(spec.implementation_start_gate.blocking_conformance_adapters, 2);
  assert.ok(
    [positive, negative, nonApplicable]
      .every((fixture) => fixture.execution_evidence.status === 'not_collected'),
  );
  assert.equal(schema.$defs.Revision.pattern, '^(0|[1-9][0-9]*)$');
  assert.equal(producer.fixture_set_sha256, manifest.fixture_set_sha256);
  assert.equal(consumer.fixture_set_sha256, manifest.fixture_set_sha256);
  assert.ok(
    [positive, negative, nonApplicable]
      .every((fixture) => fixture.fixture_set_sha256 === manifest.fixture_set_sha256),
  );
  assert.equal(fingerprint.fixture_sha256.canonical_fixture_set, manifest.fixture_set_sha256);

  const canonicalFixturePath = (relativePath) =>
    `contracts/mana-brainbase-tenant-context/v1/fixtures/${relativePath}`;
  for (const [fixture, manifestKey] of [
    [positive, 'positive'],
    [negative, 'negative'],
    [nonApplicable, 'non_applicable'],
  ]) {
    assert.equal(fixture.case_count, manifest[manifestKey].length);
    assert.deepEqual(
      fixture.canonical_fixtures,
      manifest[manifestKey].map(canonicalFixturePath),
    );
  }
  for (const fixtureKind of ['positive', 'negative', 'non_applicable']) {
    const fixtureFile = fixtureKind.replace('_', '-');
    const bytes = await readFile(new URL(`fixtures/${fixtureFile}.json`, root));
    assert.equal(
      fingerprint.fixture_sha256[fixtureKind],
      createHash('sha256').update(bytes).digest('hex'),
    );
  }

  const draft = await readFile(new URL('draft.json', root));
  const digest = createHash('sha256').update(draft).digest('hex');
  assert.equal(fingerprint.draft_spec_sha256, digest);
  assert.equal(fingerprint.blocking_open_decision_count, 0);
  assert.equal(fingerprint.implementation_start_gate, 'BLOCKED');
});
