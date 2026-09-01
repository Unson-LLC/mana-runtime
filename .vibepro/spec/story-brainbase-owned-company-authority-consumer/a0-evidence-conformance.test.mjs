import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateSpecFinalNegativeEvidence } from "./generate-spec-final-negative-evidence.mjs";

const root = new URL("../../../", import.meta.url);
const specRoot = new URL(".vibepro/spec/story-brainbase-owned-company-authority-consumer/", root);
const contractRoot = new URL("contracts/mana-brainbase-company-authority/v1/", root);

const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("production E2E plan is bound to the locked producer and remains not_collected", async () => {
  const [plan, lock, producer, fixtures, requestSchema, spec] = await Promise.all([
    readJson(new URL("production-e2e-plan.json", specRoot)),
    readJson(new URL("consumer-source-lock.json", contractRoot)),
    readJson(new URL("producer.contract.json", contractRoot)),
    readJson(new URL("fixtures/cases.json", contractRoot)),
    readJson(new URL("schema/observed-execution-request.schema.json", contractRoot)),
    readJson(new URL("spec.json", specRoot)),
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
  assert.equal(plan.cases.length, 14);

  const expectedPersonFixtureBindings = {
    "unknown-person": { fixtureId: "NEG-UNKNOWN-PERSON", expectedCode: "PERSON_UNKNOWN" },
    "ambiguous-person": { fixtureId: "NEG-AMBIGUOUS-PERSON", expectedCode: "PERSON_AMBIGUOUS" },
  };
  for (const [caseId, { fixtureId, expectedCode }] of Object.entries(expectedPersonFixtureBindings)) {
    const plannedCase = plan.cases.find(({ id }) => id === caseId);
    assert.ok(plannedCase, caseId);
    assert.deepEqual(plannedCase.producer_fixture_ids, [fixtureId], caseId);
    assert.equal(plannedCase.expected_code, expectedCode, caseId);
    assert.ok(canonicalCodes.has(expectedCode), `${caseId}: ${expectedCode}`);
    const fixture = fixturesById.get(fixtureId);
    assert.ok(fixture, `${caseId}: ${fixtureId}`);
    assert.equal(fixture.category, "unknown_person", `${caseId}: ${fixtureId}`);
    assert.equal(fixture.expected.code, expectedCode, `${caseId}: ${fixtureId}`);
  }

  const crossOrg = plan.cases.find(({ id }) => id === "tenant-boundary");
  const expectedCrossOrgFixtureIds = [
    "NEG-CROSS-ORG-TENANT-A-PERSON-SATO",
    "NEG-CROSS-ORG-TENANT-A-PERSON-UMEDA",
    "NEG-CROSS-ORG-TENANT-B-PERSON-SATO",
    "NEG-CROSS-ORG-TENANT-B-PERSON-UMEDA",
  ];
  assert.deepEqual([...crossOrg.producer_fixture_ids].sort(), [...expectedCrossOrgFixtureIds].sort());
  assert.equal(new Set(crossOrg.producer_fixture_ids).size, expectedCrossOrgFixtureIds.length);
  for (const fixtureId of expectedCrossOrgFixtureIds) {
    const fixture = fixturesById.get(fixtureId);
    assert.ok(fixture, `tenant-boundary: ${fixtureId}`);
    assert.equal(fixture.category, "cross_org", `tenant-boundary: ${fixtureId}`);
    assert.equal(fixture.expected.code, "AUTHORITY_CROSS_ORG", `tenant-boundary: ${fixtureId}`);
  }

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
    assert.ok(["defined", "not_defined"].includes(plannedCase.expected_code_status), plannedCase.id);
    assert.ok(["retry_after_remediation", "do_not_retry", "diagnostic_only"].includes(plannedCase.operator_remediation.retryability), plannedCase.id);
    assert.match(plannedCase.operator_remediation.rejection_reason, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u, plannedCase.id);
    assert.match(plannedCase.operator_remediation.next_action, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u, plannedCase.id);
    assert.match(plannedCase.operator_remediation.support_route, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u, plannedCase.id);
    assert.match(plannedCase.operator_visible_surface, /Slack|CLI/, plannedCase.id);
    if (plannedCase.expected_code_status === "defined") {
      assert.ok(canonicalCodes.has(plannedCase.expected_code), plannedCase.id);
    } else {
      assert.equal(plannedCase.expected_code, null, plannedCase.id);
      assert.equal(plannedCase.code_owner, "T0", plannedCase.id);
      assert.equal(plannedCase.success_eligible, false, plannedCase.id);
      assert.equal(plannedCase.coverage_eligible, false, plannedCase.id);
    }
    assert.ok(Array.isArray(plannedCase.producer_fixture_ids), plannedCase.id);
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

  assert.deepEqual(
    plan.cases.map(({ id }) => id),
    [
      "tenant-boundary", "personal-owner-boundary", "unknown-person", "ambiguous-person",
      "stale-raci", "stale-policy", "wrong-approver", "queue-redelivery",
      "key-rotation-old-kid", "key-revocation", "legacy-runtime", "dual-read-migration",
      "company-authority-missing", "brainbase-unavailable-no-fallback",
    ],
  );
  for (const id of ["key-rotation-old-kid", "key-revocation"]) {
    const keyCase = plan.cases.find((plannedCase) => plannedCase.id === id);
    assert.equal(keyCase.implementation_status, "not_implemented");
    assert.equal(keyCase.coverage_status, "not_collected");
    assert.ok(keyCase.kid_before);
    assert.ok(keyCase.kid_after);
  }
  const missingAuthority = plan.cases.find(({ id }) => id === "company-authority-missing");
  const diagnosticAllowlist = ["health", "protocol_negotiation", "provisioning", "connection_diagnostic", "tenant_isolation_test"];
  assert.deepEqual(producer.fixture_coverage.diagnostic_allowlist, diagnosticAllowlist);
  assert.deepEqual(missingAuthority.allowed_operations, producer.fixture_coverage.diagnostic_allowlist);
  assert.equal(missingAuthority.business_operation, "rejected");

  const queue = plan.cases.find(({ id }) => id === "queue-redelivery");
  assert.equal(queue.first_delivery_outcome, "rejected");
  assert.equal(queue.original_rejection_code, queue.expected_code);
  assert.equal(queue.redelivery_rejection_code, queue.original_rejection_code);
  assert.equal(queue.original_effect_count, 0);
  assert.equal(queue.redelivery_effect_delta, 0);
  assert.equal(queue.aggregate_effect_count, 0);
  assert.equal(queue.accepted_first_delivery_plan, "out_of_scope_not_counted_as_negative_case_evidence");

  assert.deepEqual(plan.runtime_execution_evidence, {
    "AC-005": {
      status: "not_collected",
      owner: "T0",
      a0_fixture_boundary: "acceptance preserves auto, approval, and human_action decisions and rejects deny or nested-signature tampering before effects",
      required_assertions: [
        "auto executes only the signed allowed effects",
        "approval creates the Brainbase-specified approval path without protected effect",
        "human_action remains pending until the Brainbase-specified person completes it",
        "deny executes no model, credential, Graph, Task, or external effect",
      ],
      exit_condition: "collect decision-specific runtime state and zero-effect evidence after the T0 adapter exists",
      fixture_acceptance_is_runtime_execution_proof: false,
    },
    "AC-004": {
      status: "not_collected",
      owner: "T0",
      required_surfaces: [
        "Worker",
        "Queue",
        "Durable Object",
        "Container",
        "MCP",
        "Brainbase proxy",
        "Slack delivery",
      ],
      exit_condition: "wire the fixture-validated consumer into every listed runtime boundary and collect deterministic rejection and no-effect evidence",
      fixture_mock_is_runtime_integration_proof: false,
      assertCanonicalAuthorityRetrieval_is_runtime_integration_proof: false,
    },
    "AC-010": {
      status: "not_collected",
      owner: "T0",
      required_assertions: [
        "duplicate delivery executes model, Brainbase write, external side effect, and Slack delivery exactly once",
        "both deliveries preserve the same Receipt, correlation ID, and idempotency identity",
      ],
      exit_condition: "collect deterministic runtime effect counters and identity-linked receipt readback after the T0 adapter exists",
      fixture_mock_is_production_proof: false,
    },
    "AC-011": {
      status: "not_collected",
      owner: "T0",
      required_assertions: [
        "OperationReceipt, UsageEvent, external readback, and authority-resolution receipt share one correlation ID",
        "completion remains incomplete when any required evidence is absent",
      ],
      exit_condition: "collect the correlated runtime artifacts after the T0 adapter and receipt surfaces exist",
      fixture_mock_is_production_proof: false,
    },
  });

  const transition = plan.runtime_adapter_transition;
  assert.equal(transition.owner, "T0");
  assert.equal(transition.implementation_status, "not_implemented");
  assert.equal(transition.evidence_status, "not_collected");
  assert.equal(transition.implementation_claim, "none");
  assert.equal(transition.endpoint_binding, "not_defined");
  assert.deepEqual(transition.eligible_providers, requestSchema["x-supported-providers"]);
  assert.deepEqual(transition.unsupported_providers, { service: "not_implemented" });
  assert.deepEqual(
    [...new Set(Object.values(transition.mapping).map((path) => path.split(".")[0]))].sort(),
    Object.keys(requestSchema.properties).sort(),
  );
  assert.deepEqual(transition.forbidden_public_body_fields, [
    "tenant_id",
    "expected_tenant_revision",
    "connection_id",
    "expected_connection_revision",
    "workspace_id",
    "app_id",
    "slack",
    "operation_id",
    "requested_action.project_ids",
  ]);
  assert.match(transition.desired_effect_policy, /unknown capability is rejected/);
  assert.equal(transition.legacy_fallback_after_v1_opt_in, "forbidden");
  assert.match(transition.dual_read_disagreement, /AUTHORITY_UNAVAILABLE/);
  assert.match(transition.rollback, /reject the business operation/);
  assert.ok(transition.future_tests.length >= 6);

  const clauseById = new Map(spec.clauses.map((clause) => [clause.id, clause]));
  assert.deepEqual(
    clauseById.get("INV-001").origin.story_refs.map(({ ac_id }) => ac_id),
    ["AC-005"],
  );
  assert.equal(clauseById.get("C-002").origin.story_refs[0].ac_id, "AC-003");
  assert.equal(clauseById.get("BND-004").origin.story_refs[0].ac_id, "AC-004");
  assert.equal(clauseById.get("BND-006").origin.story_refs[0].ac_id, "AC-005");
  assert.deepEqual(
    clauseById.get("BND-005").origin.story_refs.map(({ ac_id }) => ac_id),
    ["AC-001", "AC-002", "AC-007"],
  );
  assert.equal(clauseById.get("BND-002").origin.story_refs[0].ac_id, "AC-010");
  assert.equal(clauseById.get("BND-003").origin.story_refs[0].ac_id, "AC-011");
});

test("spec final rejection evidence is generated from the real command and content-bound", async () => {
  const temporaryArtifactDir = await mkdtemp(join(tmpdir(), "a0-spec-final-evidence-"));
  const result = await generateSpecFinalNegativeEvidence({ repoRoot: root, artifactDir: temporaryArtifactDir });
  await generateSpecFinalNegativeEvidence({ repoRoot: root });
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
  assert.deepEqual(result.manifest.reason_codes, result.manifest.expected_reason_codes);
  assert.equal(result.manifest.reason_codes.includes("pattern_no_files"), false);
  assert.equal(sha256(await readFile(result.logPath)), result.manifest.raw_log.sha256);
  assert.equal(sha256(await readFile(result.manifestPath)), (await readFile(result.sidecarPath, "utf8")).trim());
  await assert.rejects(access(legacyArtifact), { code: "ENOENT" });
  const canonicalRoot = new URL(
    ".vibepro/pr/story-brainbase-owned-company-authority-consumer/spec-final-negative-evidence/",
    root,
  );
  const canonicalManifestPath = new URL("manifest.json", canonicalRoot);
  const canonicalLogPath = new URL("raw.log", canonicalRoot);
  const canonicalSidecarPath = new URL("manifest.sha256", canonicalRoot);
  const canonicalManifestBytes = await readFile(canonicalManifestPath);
  const canonicalManifest = JSON.parse(canonicalManifestBytes);
  const canonicalManifestSha256 = sha256(canonicalManifestBytes);
  assert.equal(canonicalManifestSha256, (await readFile(canonicalSidecarPath, "utf8")).trim());
  assert.equal(sha256(await readFile(canonicalLogPath)), canonicalManifest.raw_log.sha256);
  assert.equal(canonicalManifest.git.head_before, canonicalManifest.git.head_after);
  assert.equal(canonicalManifest.git.head_before, execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim());
  assert.equal(canonicalManifest.success_claim, false);
  process.stdout.write(
    `SPEC_FINAL_NEGATIVE_EVIDENCE ${JSON.stringify({
      manifest_path: canonicalManifest.manifest_path,
      manifest_sha256: canonicalManifestSha256,
      raw_log_path: canonicalManifest.raw_log.path,
      raw_log_sha256: canonicalManifest.raw_log.sha256,
      exit_code: canonicalManifest.exit_code,
      success_claim: canonicalManifest.success_claim,
    })}\n`,
  );
  await rm(temporaryArtifactDir, { recursive: true, force: true });
});
