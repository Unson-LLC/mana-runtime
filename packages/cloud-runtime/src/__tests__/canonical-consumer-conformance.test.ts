import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  CANONICAL_FIXTURE_SET_SHA256,
  CanonicalContractError,
  assertCanonicalAuthorityRetrieval,
  negotiateCanonicalProtocol,
  validateCanonicalConsumerFlow,
  validateCanonicalCredentialLease,
  validateCanonicalEnvelope,
  validateCanonicalIdempotencyClaim,
  validateCanonicalNonApplicable,
  validateCanonicalOperationReceipt,
  validateCanonicalQuotaDecision,
  validateCanonicalUsageEvent,
} from "../multitenancy/canonical-consumer.js";
import { jcsCanonicalize } from "../multitenancy/jcs.js";
const {
  COMPANY_AUTHORITY_CAPABILITY,
  applyFixtureMutations,
  validateCanonicalExecutionContext,
  validateObservedExecutionRequest,
  verifyDetachedJws,
// @ts-expect-error The exact producer reference validator is intentionally vendored as an .mjs contract artifact.
} = await import("../../../../contracts/mana-brainbase-company-authority/v1/reference/wire.mjs");

const contractRoot = new URL("../../../../contracts/mana-brainbase-tenant-context/v1/", import.meta.url);
const fixtureRoot = new URL("fixtures/", contractRoot);

interface Manifest {
  fixture_set_sha256: string;
  test_key: string;
  positive: string[];
  negative: string[];
  non_applicable: string[];
}

interface NegativeFixture {
  target: string;
  mutations: Array<{
    operation: "set" | "delete" | "rename" | "replace_protected_header";
    path?: string;
    to?: string;
    value?: unknown;
  }>;
  expected_code: string;
  business_api_called: false;
}

async function readJson<T>(path: string, root = contractRoot): Promise<T> {
  return JSON.parse(await readFile(new URL(path, root), "utf8")) as T;
}

function resolvePointer(value: Record<string, unknown>, pointer: string): unknown {
  return pointer.split("/").filter(Boolean).reduce<unknown>((current, key) =>
    (current as Record<string, unknown>)[key], value);
}

function parentForPointer(value: unknown, pointer: string): { parent: Record<string, unknown>; key: string } {
  const parts = pointer.split("/").filter(Boolean);
  const key = parts.pop();
  if (!key) throw new Error(`invalid JSON pointer: ${pointer}`);
  const parent = parts.reduce<unknown>((current, part) =>
    (current as Record<string, unknown>)[part], value);
  return { parent: parent as Record<string, unknown>, key };
}

function applyMutations(value: unknown, mutations: NegativeFixture["mutations"]): unknown {
  const result = structuredClone(value) as Record<string, unknown>;
  for (const mutation of mutations) {
    if (mutation.operation === "replace_protected_header") {
      const integrity = result.integrity as Record<string, unknown>;
      const [, detached, signature] = String(integrity.value).split(".");
      expect(detached).toBe("");
      const protectedHeader = Buffer.from(jcsCanonicalize(mutation.value)).toString("base64url");
      integrity.value = `${protectedHeader}..${signature}`;
      continue;
    }
    const { parent, key } = parentForPointer(result, mutation.path ?? "");
    if (mutation.operation === "set") parent[key] = mutation.value;
    else if (mutation.operation === "delete") delete parent[key];
    else if (mutation.operation === "rename") {
      parent[mutation.to ?? ""] = parent[key];
      delete parent[key];
    }
  }
  return result;
}

async function fixtureDigest(manifest: Manifest): Promise<string> {
  const hash = createHash("sha256");
  for (const path of [manifest.test_key, ...manifest.positive, ...manifest.negative, ...manifest.non_applicable]) {
    hash.update(path);
    hash.update(Buffer.from([0]));
    hash.update(await readFile(new URL(path, fixtureRoot)));
  }
  return hash.digest("hex");
}

async function validateNegative(fixture: NegativeFixture, base: Record<string, unknown>, publicJwk: JsonWebKey): Promise<void> {
  const mutated = applyMutations(resolvePointer(base, fixture.target), fixture.mutations);
  const now = String(base.evaluation_time);
  if (fixture.target === "tenant_context_envelope") {
    await validateCanonicalEnvelope(mutated, { now, public_jwk: publicJwk });
    return;
  }
  if (fixture.target === "protocol_request") {
    negotiateCanonicalProtocol(mutated, base.protocol_response);
    return;
  }
  if (fixture.target === "credential_lease_response") {
    validateCanonicalCredentialLease(base.credential_lease_request, mutated, { now });
    return;
  }
  if (fixture.target === "quota_decision") {
    validateCanonicalQuotaDecision(mutated);
    return;
  }
  if (fixture.target === "operation_receipt") {
    validateCanonicalOperationReceipt(mutated);
    return;
  }
  if (fixture.target.startsWith("usage_events/")) {
    validateCanonicalUsageEvent(mutated);
    return;
  }
  if (fixture.target.startsWith("idempotency_claims/")) {
    await validateCanonicalIdempotencyClaim(mutated);
    return;
  }
  throw new Error(`unsupported fixture target: ${fixture.target}`);
}

describe("mana-runtime canonical consumer", () => {
  it("mana-runtime consumer reads PR237 canonical fixture manifest", async () => {
    const manifest = await readJson<Manifest>("fixtures/manifest.json");
    const positive = await readJson<Record<string, unknown>>(manifest.positive[0], fixtureRoot);
    const key = await readJson<{ public_jwk: JsonWebKey }>(manifest.test_key, fixtureRoot);
    const businessEffect = vi.fn();

    expect(manifest.positive).toHaveLength(1);
    expect(manifest.negative).toHaveLength(21);
    expect(manifest.non_applicable).toHaveLength(1);
    expect(await fixtureDigest(manifest)).toBe("9f544ab944407db760e4dec79c455bea2fdc9076766ecfd4c7058417cfe7c833");
    expect(CANONICAL_FIXTURE_SET_SHA256).toBe(manifest.fixture_set_sha256);

    await validateCanonicalConsumerFlow(positive, { public_jwk: key.public_jwk });
    businessEffect("positive");

    for (const path of manifest.negative) {
      const fixture = await readJson<NegativeFixture>(path, fixtureRoot);
      await expect(validateNegative(fixture, positive, key.public_jwk)).rejects.toEqual(
        expect.objectContaining({ code: fixture.expected_code }),
      );
      expect(fixture.business_api_called).toBe(false);
    }

    const nonApplicable = await readJson<Record<string, unknown>>(manifest.non_applicable[0], fixtureRoot);
    expect(validateCanonicalNonApplicable(nonApplicable)).toEqual({ mandatory_capability_waiver_count: 0 });
    expect(businessEffect).toHaveBeenCalledTimes(1);
  });

  it("rejects canonical contract violations with a stable code", () => {
    expect(() => validateCanonicalQuotaDecision({ message_type: "quota_decision", quota_revision: 1 }))
      .toThrow(CanonicalContractError);
  });
});

describe("Brainbase-owned company authority A0 fixture consumer", () => {
  const companyContractRoot = new URL(
    "../../../../contracts/mana-brainbase-company-authority/v1/",
    import.meta.url,
  );

  it("pins the exact producer source lock and artifact digests", async () => {
    const lock = await readJson<{
      accepted_producer: {
        repository: string;
        ref: string;
        merged_sha: string;
        root_path: string;
        fixture_set_sha256: string;
        artifact_sha256: Record<string, string>;
      };
      consumer_boundary: { production_proof: string; behavior: string; semantic_generation: string };
    }>("consumer-source-lock.json", companyContractRoot);
    const manifest = await readJson<{ fixture_files: string[]; fixture_set_sha256: string }>(
      "fixtures/manifest.json",
      companyContractRoot,
    );

    expect(lock.accepted_producer).toMatchObject({
      repository: "Unson-LLC/brainbase-unson",
      ref: "develop",
      merged_sha: "ad908bce7b90678f9ed7f1c570f808bdf1a500ad",
      root_path: "contracts/mana-brainbase-company-authority/v1",
      fixture_set_sha256: "1d7af5b850abeb10e07db281c17341636d80a74cb37679b2c2b6ab5ce9b0a6ea",
    });
    for (const [path, digest] of Object.entries(lock.accepted_producer.artifact_sha256)) {
      expect(createHash("sha256").update(await readFile(new URL(path, companyContractRoot))).digest("hex"), path)
        .toBe(digest);
    }
    const hash = createHash("sha256");
    for (const path of manifest.fixture_files) {
      hash.update(path);
      hash.update(Buffer.from([0]));
      hash.update(await readFile(new URL(path, companyContractRoot)));
    }
    expect(hash.digest("hex")).toBe(lock.accepted_producer.fixture_set_sha256);
    expect(lock.consumer_boundary).toMatchObject({
      behavior: "verify_and_propagate_only",
      semantic_generation: "forbidden",
      production_proof: "not_collected",
    });
  });

  it("accepts all signed positive contexts without generating Mana authority semantics", async () => {
    const contract = await readJson<{ signature: { audience: string } }>("producer.contract.json", companyContractRoot);
    const fixtures = await readJson<{
      positive: Array<Record<string, any>>;
    }>("fixtures/cases.json", companyContractRoot);
    const key = await readJson<{ public_jwk: JsonWebKey }>("fixtures/test-key.json", companyContractRoot);
    const decisions = new Set<string>();

    expect(fixtures.positive).toHaveLength(9);
    for (const fixture of fixtures.positive) {
      validateObservedExecutionRequest(fixture.request);
      if (!fixture.context) continue;
      const accepted = validateCanonicalExecutionContext(fixture.context, {
        expectedAudience: contract.signature.audience,
        now: fixture.evaluation_time,
        request: fixture.request,
      });
      verifyDetachedJws(fixture.context, key.public_jwk);
      expect(accepted).toBe(fixture.context);
      expect(fixture.context.tenant_context.authorization.capability_ids)
        .toContain(COMPANY_AUTHORITY_CAPABILITY);
      expect(fixture.context.authority.capability_id).toBe(fixture.request.requested_action.capability_id);
      expect(fixture.context.evidence.authority_resolution_receipt_id).toEqual(expect.any(String));
      expect(fixture.context.tenant_context.idempotency_key).toMatch(/^ik1_/);
      decisions.add(fixture.context.authority.decision);
    }
    expect([...decisions].sort()).toEqual(["approval", "auto", "deny", "human_action"]);
  });

  it("fails closed for all producer negative fixtures and preserves their no-effect contract", async () => {
    const contract = await readJson<{ signature: { audience: string } }>("producer.contract.json", companyContractRoot);
    const fixtures = await readJson<{
      positive: Array<Record<string, any>>;
      negative: Array<Record<string, any>>;
    }>("fixtures/cases.json", companyContractRoot);
    const key = await readJson<{ public_jwk: JsonWebKey }>("fixtures/test-key.json", companyContractRoot);
    expect(fixtures.negative).toHaveLength(52);
    for (const fixture of fixtures.negative) {
      const base = fixtures.positive.find(({ id }) => id === fixture.base_fixture);
      expect(base, fixture.id).toBeDefined();
      const mutated = applyFixtureMutations({ request: base!.request, context: base!.context }, fixture.mutations);
      let code: string | undefined;
      try {
        if (fixture.target === "request") validateObservedExecutionRequest(mutated.request);
        else if (fixture.target === "context") {
          validateCanonicalExecutionContext(mutated.context, {
            expectedAudience: contract.signature.audience,
            now: fixture.evaluation_time ?? base!.evaluation_time,
          });
          verifyDetachedJws(mutated.context, key.public_jwk);
        } else {
          validateCanonicalExecutionContext(mutated.context, {
            expectedAudience: contract.signature.audience,
            now: fixture.evaluation_time ?? base!.evaluation_time,
            request: mutated.request,
            expectedRevisions: fixture.expected_revisions,
            identityStatus: fixture.identity_status,
            crossOrg: fixture.cross_org,
            scopeMismatch: fixture.scope_mismatch,
            membershipStatus: fixture.membership_status,
            authorityUnavailable: fixture.authority_unavailable,
            approvalSubjectId: fixture.approval_subject_id,
            personalTargetPersonId: fixture.personal_target_person_id,
            replayConflict: fixture.replay_conflict,
          });
        }
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code, fixture.id).toBe(fixture.expected.code);
      expect(fixture.expected.business_effects).toEqual({
        business_api_called: false,
        llm_called: false,
        credential_lease_issued: false,
        external_side_effect: false,
      });
    }

    const retrievalSchema = await readJson<Record<string, any>>(
      "consumer-conformance/authority-retrieval-state.schema.json",
      companyContractRoot,
    );
    expect(retrievalSchema.properties.cases.items.properties.state.enum).toEqual([
      "no_data", "unknown", "partial", "not_collected",
    ]);
    expect(retrievalSchema.properties.cases.items.properties.expected_code.const).toBe("AUTHORITY_UNAVAILABLE");

    const retrievalFixtures = await readJson<{
      cases: Array<{ id: string; state: "no_data" | "unknown" | "partial" | "not_collected"; expected_code: string; business_effect: false }>;
    }>("consumer-conformance/authority-retrieval-state.fixture.json", companyContractRoot);
    expect(retrievalFixtures.cases).toHaveLength(4);
    for (const fixture of retrievalFixtures.cases) {
      expect(() => assertCanonicalAuthorityRetrieval(fixture.state), fixture.id).toThrow(
        expect.objectContaining({ code: fixture.expected_code }),
      );
      expect(fixture.business_effect).toBe(false);
    }
  });
});
