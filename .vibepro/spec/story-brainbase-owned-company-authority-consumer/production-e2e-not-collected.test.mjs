import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export const production_e2e_not_collected = true;

test("T0 local implementation state does not promote production evidence", async () => {
  const plan = JSON.parse(await readFile(new URL("./production-e2e-plan.json", import.meta.url), "utf8"));
  const consumerDraft = JSON.parse(await readFile(new URL("./draft.json", import.meta.url), "utf8"));
  const consumerSpec = JSON.parse(await readFile(new URL("./spec.json", import.meta.url), "utf8"));
  const runtimeDraft = JSON.parse(
    await readFile(
      new URL("../story-brainbase-owned-company-authority-runtime-adapter-v1/draft.json", import.meta.url),
      "utf8",
    ),
  );
  const runtimeSpec = JSON.parse(
    await readFile(
      new URL("../story-brainbase-owned-company-authority-runtime-adapter-v1/spec.json", import.meta.url),
      "utf8",
    ),
  );
  const consumerStory = await readFile(
    new URL(
      "../../../docs/management/stories/active/story-brainbase-owned-company-authority-consumer.md",
      import.meta.url,
    ),
    "utf8",
  );
  const runtimeStory = await readFile(
    new URL(
      "../../../docs/management/stories/active/story-brainbase-owned-company-authority-runtime-adapter-v1.md",
      import.meta.url,
    ),
    "utf8",
  );

  assert.equal(
    plan.runtime_adapter_transition.implementation_status,
    "local_implementation_present_production_not_verified",
  );
  assert.equal(
    plan.runtime_adapter_transition.implementation_claim,
    "local_adapter_queue_and_selected_container_boundaries_only",
  );
  assert.equal(plan.runtime_adapter_transition.evidence_status, "not_collected");
  assert.equal(plan.status, "not_collected");
  assert.equal(plan.dependencies.production_e2e, "not_collected");
  assert.equal(
    plan.dependencies.T0,
    "in_progress_local_implementation_present_production_not_verified",
  );

  assert.equal(
    plan.surface_contract.implementation_status,
    "local_runtime_surfaces_implemented_production_surfaces_not_verified",
  );
  assert.deepEqual(plan.runtime_adapter_transition.future_tests, [
    "credential-backed production endpoint accepts only public-contract fields and rejects forbidden legacy fields",
    "production provider route uses the configured trusted endpoint and public Ed25519 verification material",
    "unknown capability and unsupported provider remain rejected under production configuration",
    "schema rejection, authority unavailability, or dual-read disagreement never retries legacy authorization in live runtime",
    "2 tenant x 2 person negative cases preserve business effect 0 and correlated receipts/readback",
    "duplicate delivery preserves one effect identity with production provider reconciliation and readback",
  ]);
  assert.equal(
    plan.runtime_adapter_transition.exit_condition,
    "bind the credential-backed production endpoint and trust/provider configuration, run live compatibility and no-fallback tests, and collect same-run receipts and external readback",
  );

  for (const artifact of [consumerDraft, consumerSpec]) {
    const bnd004 = artifact.clauses.find(({ id }) => id === "BND-004");
    const bnd005 = artifact.clauses.find(({ id }) => id === "BND-005");
    const bnd006 = artifact.clauses.find(({ id }) => id === "BND-006");
    assert.match(bnd004.statement, /T0でローカル実装・検証済み/);
    assert.match(bnd004.statement, /production endpoint／trust binding.*not_collected/);
    assert.match(bnd005.statement, /local adapter、Queue、selected Container境界は実装・ローカル検証済み/);
    assert.match(bnd005.statement, /production endpoint／trust binding.*not_collected/);
    assert.match(bnd006.statement, /T0でローカルroutingと作用ゼロ境界を実装・検証済み/);
    assert.match(bnd006.statement, /production provider.*not_collected/);
  }
  assert.match(consumerStory, /T0のlocal adapter、Queue、selected Container境界は実装・ローカル検証済み/);
  assert.match(consumerStory, /T0では7 surfaceのローカル接続と再検証を実装・検証済み/);
  assert.doesNotMatch(consumerStory, /T0 runtime adapter未実装/);

  for (const runtimeArtifact of [runtimeDraft, runtimeSpec]) {
    assert.equal(
      runtimeArtifact.implementation_state.runtime_evidence,
      "local_runtime_boundaries_verified_production_not_collected",
    );
    assert.equal(runtimeArtifact.implementation_state.production_evidence, "not_collected");
    assert.equal(
      runtimeArtifact.multi_tenancy.failure_semantics.no_data,
      "deny_as_authority_unavailable",
    );
    assert.equal(
      runtimeArtifact.multi_tenancy.verification.evidence_state,
      "local_runtime_boundaries_verified_production_not_collected",
    );
    assert.ok(runtimeArtifact.clauses.some(({ id }) => id === "INV-004"));
  }

  const cases = new Map(plan.cases.map((item) => [item.id, item]));
  assert.equal(cases.get("legacy-runtime").implementation_status, "case_not_implemented_local_runtime_adapter_present");
  assert.match(cases.get("legacy-runtime").next_action, /production endpoint／trust binding後/);
  assert.equal(cases.get("company-authority-missing").implementation_status, "case_not_implemented_local_runtime_adapter_present");
  assert.match(cases.get("company-authority-missing").next_action, /production endpoint／trust binding後/);
  assert.equal(cases.get("dual-read-migration").implementation_status, "migration_case_not_implemented_local_runtime_adapter_present");
  assert.match(cases.get("dual-read-migration").next_action, /production endpoint／trust binding/);
  assert.equal(cases.get("brainbase-unavailable-no-fallback").implementation_status, "local_fail_closed_verified_production_not_verified");
  assert.match(cases.get("brainbase-unavailable-no-fallback").next_action, /production provider route/);
  assert.match(runtimeStory, /no_data.*AUTHORITY_UNAVAILABLE/);
});

test("production 2x2 tenant/person E2E remains not_collected", {
  skip: "A0 fixture/mock conformance is not production 2x2 tenant/person E2E evidence",
}, () => {});

test("AC-004 runtime boundary integrations remain not_collected", {
  skip: "T0 locally wires injected boundaries, but production Worker, Queue, Durable Object, Container, MCP, Brainbase proxy, Slack delivery, and live readback remain not_collected",
}, () => {});

test("AC-005 runtime decision execution remains not_collected", {
  skip: "T0 locally tests auto, approval, and human_action routing, but production-bound decision execution and effect readback remain not_collected",
}, () => {});

test("AC-010 runtime duplicate delivery and exactly-once effects remain not_collected", {
  skip: "T0 locally tests the durable outbox contract, but production provider calls, duplicate-delivery counters, and external readback remain not_collected",
}, () => {});

test("AC-011 correlated runtime completion evidence remains not_collected", {
  skip: "A0 fixture/mock conformance does not emit OperationReceipt, UsageEvent, external readback, and authority receipt",
}, () => {});

test("T0 Slack runtime adapter mapping and compatibility evidence remain not_collected", {
  skip: "T0 implements the local adapter mapping, while production endpoint binding, cutover, dual-read, and live no-fallback evidence remain not_collected",
}, () => {});
