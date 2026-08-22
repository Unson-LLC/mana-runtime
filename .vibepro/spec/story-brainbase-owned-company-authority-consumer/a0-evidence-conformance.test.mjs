import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { generateSpecFinalNegativeEvidence } from "./generate-spec-final-negative-evidence.mjs";

const root = new URL("../../../", import.meta.url);
const specRoot = new URL(".vibepro/spec/story-brainbase-owned-company-authority-consumer/", root);
const contractRoot = new URL("contracts/mana-brainbase-company-authority/v1/", root);

const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("production E2E plan is bound to the locked producer and remains not_collected", async () => {
  const [plan, lock, producer, fixtures] = await Promise.all([
    readJson(new URL("production-e2e-plan.json", specRoot)),
    readJson(new URL("consumer-source-lock.json", contractRoot)),
    readJson(new URL("producer.contract.json", contractRoot)),
    readJson(new URL("fixtures/cases.json", contractRoot)),
  ]);

  assert.equal(plan.status, "not_collected");
  assert.equal(plan.acceptance_criterion, "AC-012");
  assert.deepEqual(plan.canonical_code_source, {
    repository: lock.accepted_producer.repository,
    ref: lock.accepted_producer.ref,
    sha: lock.accepted_producer.merged_sha,
    path: lock.accepted_producer.root_path,
    fixture_set_sha256: lock.accepted_producer.fixture_set_sha256,
  });
  assert.deepEqual(plan.undefined_code_policy, {
    expected_code: null,
    expected_code_status: "not_defined",
    owner: "T0",
    success_eligible: false,
    coverage_eligible: false,
    next_action: "define the canonical rejection code in the producer contract before collecting E2E evidence",
  });

  const canonicalCodes = new Set(producer.canonical_error_codes);
  const fixturesById = new Map(fixtures.negative.map((fixture) => [fixture.id, fixture]));
  assert.equal(plan.cases.length, 8);
  for (const plannedCase of plan.cases) {
    assert.equal(plannedCase.current_state, "not_collected", plannedCase.id);
    assert.equal(plannedCase.coverage_status, "not_collected", plannedCase.id);
    assert.equal(plannedCase.business_effect, false, plannedCase.id);
    assert.equal(plannedCase.side_effect_count, 0, plannedCase.id);
    assert.match(plannedCase.receipt_readback, /correlation_id/, plannedCase.id);
    assert.match(plannedCase.receipt_readback, /receipt/i, plannedCase.id);
    assert.ok(plannedCase.forbidden_display.includes("success"), plannedCase.id);
    assert.ok(plannedCase.forbidden_display.includes("empty"), plannedCase.id);
    assert.ok(plannedCase.forbidden_display.includes("in_progress"), plannedCase.id);
    assert.equal(plannedCase.expected_code_status, "defined", plannedCase.id);
    assert.ok(canonicalCodes.has(plannedCase.expected_code), plannedCase.id);
    assert.ok(plannedCase.producer_fixture_ids.length > 0, plannedCase.id);
    for (const fixtureId of plannedCase.producer_fixture_ids) {
      const fixture = fixturesById.get(fixtureId);
      assert.ok(fixture, `${plannedCase.id}: ${fixtureId}`);
      assert.equal(fixture.expected.code, plannedCase.expected_code, `${plannedCase.id}: ${fixtureId}`);
      assert.equal(fixture.expected.outcome, "deny_without_effect", `${plannedCase.id}: ${fixtureId}`);
      assert.ok(
        Object.values(fixture.expected.business_effects).every((value) => value === false),
        `${plannedCase.id}: ${fixtureId}`,
      );
    }
  }

  const queue = plan.cases.find(({ id }) => id === "queue-redelivery");
  assert.equal(queue.first_delivery_outcome, "rejected");
  assert.equal(queue.original_rejection_code, queue.expected_code);
  assert.equal(queue.redelivery_rejection_code, queue.original_rejection_code);
  assert.equal(queue.original_effect_count, 0);
  assert.equal(queue.redelivery_effect_delta, 0);
  assert.equal(queue.aggregate_effect_count, 0);
  assert.equal(queue.accepted_first_delivery_plan, "out_of_scope_not_counted_as_negative_case_evidence");
});

test("spec final rejection evidence is generated from the real command and content-bound", async () => {
  const result = await generateSpecFinalNegativeEvidence({ repoRoot: root });
  const legacyArtifact = new URL(
    ".vibepro/pr/story-brainbase-owned-company-authority-consumer/spec-final-negative-evidence.json",
    root,
  );
  assert.equal(result.manifest.success_claim, false);
  assert.equal(result.manifest.exit_code, 2);
  assert.equal(result.manifest.git.head_before, result.manifest.git.head_after);
  assert.equal(result.manifest.git.porcelain_sha256_before, result.manifest.git.porcelain_sha256_after);
  assert.ok(result.manifest.reason_codes.includes("multi_tenant_failure_semantics_no_data"));
  assert.ok(result.manifest.reason_codes.includes("multi_tenant_tenant_propagation_unverified"));
  assert.equal(sha256(await readFile(result.logPath)), result.manifest.raw_log.sha256);
  assert.equal(sha256(await readFile(result.manifestPath)), (await readFile(result.sidecarPath, "utf8")).trim());
  await assert.rejects(access(legacyArtifact), { code: "ENOENT" });
  process.stdout.write(
    `SPEC_FINAL_NEGATIVE_EVIDENCE ${JSON.stringify({
      manifest_path: result.manifest.manifest_path,
      manifest_sha256: result.manifestSha256,
      raw_log_path: result.manifest.raw_log.path,
      raw_log_sha256: result.manifest.raw_log.sha256,
      exit_code: result.manifest.exit_code,
      success_claim: result.manifest.success_claim,
    })}\n`,
  );
});
