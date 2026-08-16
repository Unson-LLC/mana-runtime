import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('./', import.meta.url);

async function readJson(file) {
  return JSON.parse(await readFile(new URL(file, root), 'utf8'));
}

test('横断契約の固定決定、受入条件、fixture、fingerprintが一致する', async () => {
  const [spec, positive, negative, nonApplicable, fingerprint] = await Promise.all([
    readJson('draft.json'),
    readJson('fixtures/positive.json'),
    readJson('fixtures/negative.json'),
    readJson('fixtures/non-applicable.json'),
    readJson('fingerprint.json'),
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
  assert.equal(spec.implementation_start_gate.status, 'PASS');
  assert.ok(
    [positive, negative, nonApplicable]
      .every((fixture) => fixture.execution_evidence.status === 'not_collected'),
  );

  const draft = await readFile(new URL('draft.json', root));
  const digest = createHash('sha256').update(draft).digest('hex');
  assert.equal(fingerprint.draft_spec_sha256, digest);
  assert.equal(fingerprint.blocking_open_decision_count, 0);
  assert.equal(fingerprint.implementation_start_gate, 'PASS');
});
