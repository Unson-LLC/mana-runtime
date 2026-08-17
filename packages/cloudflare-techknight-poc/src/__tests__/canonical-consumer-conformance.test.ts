import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  CANONICAL_FIXTURE_SET_SHA256,
  CanonicalContractError,
  jcsCanonicalize,
  negotiateCanonicalProtocol,
  validateCanonicalConsumerFlow,
  validateCanonicalCredentialLease,
  validateCanonicalEnvelope,
  validateCanonicalIdempotencyClaim,
  validateCanonicalNonApplicable,
  validateCanonicalOperationReceipt,
  validateCanonicalQuotaDecision,
  validateCanonicalUsageEvent,
} from "../multitenancy/index.js";

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
