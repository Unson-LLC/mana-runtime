import { describe, expect, it } from "vitest";
import {
  parseCompanyAuthorityRuntimeConfiguration,
  type CompanyAuthorityRuntimeConfigEnv,
} from "../multitenancy/company-authority-runtime-config.js";

const publicJwk = {
  kty: "OKP",
  crv: "Ed25519",
  x: "XQRbkA9Dy21-n75vJ2ww_qTTkIXujCbsCnf-DDAgN78",
  use: "sig",
};

function validEnv(): CompanyAuthorityRuntimeConfigEnv {
  return {
    BRAINBASE_COMPANY_AUTHORITY_BASE_URL: "https://authority.example.com",
    BRAINBASE_COMPANY_AUTHORITY_EXPECTED_DEPLOYMENT_ID: "dep_trusted",
    BRAINBASE_COMPANY_AUTHORITY_PUBLIC_JWK_JSON: JSON.stringify(publicJwk),
    MANA_COMPANY_AUTHORITY_OPERATIONS_JSON: JSON.stringify({
      "task.read": "read",
      "task.write": "write",
      "slack.post": "external_side_effect",
    }),
    MANA_REQUIRED_AUDIENCE: "mana-runtime",
    BRAINBASE_TENANT_CONTEXT_JWKS_JSON: JSON.stringify({
      keys: [{ ...publicJwk, kid: "tenant-key-1" }],
    }),
  };
}

function expectInvalid(env: CompanyAuthorityRuntimeConfigEnv): void {
  expect(() => parseCompanyAuthorityRuntimeConfiguration(env))
    .toThrow(expect.objectContaining({ code: "CONFIGURATION_INVALID" }));
}

describe("company authority runtime configuration", () => {
  it("is explicitly disabled when every company authority setting is absent", () => {
    expect(parseCompanyAuthorityRuntimeConfiguration({
      MANA_REQUIRED_AUDIENCE: "existing-runtime-audience",
      BRAINBASE_TENANT_CONTEXT_JWKS_JSON: validEnv().BRAINBASE_TENANT_CONTEXT_JWKS_JSON,
    })).toEqual({ state: "disabled" });
  });

  it.each([
    "BRAINBASE_COMPANY_AUTHORITY_BASE_URL",
    "BRAINBASE_COMPANY_AUTHORITY_EXPECTED_DEPLOYMENT_ID",
    "BRAINBASE_COMPANY_AUTHORITY_PUBLIC_JWK_JSON",
    "MANA_COMPANY_AUTHORITY_OPERATIONS_JSON",
    "MANA_REQUIRED_AUDIENCE",
    "BRAINBASE_TENANT_CONTEXT_JWKS_JSON",
  ] as const)("fails closed when enabled configuration lacks %s", (binding) => {
    const env = validEnv();
    delete env[binding];
    expectInvalid(env);
  });

  it.each([
    "http://authority.example.com",
    "https://user:password@authority.example.com",
    "https://authority.example.com?tenant=message",
    "https://authority.example.com/#fragment",
    "https://authority.example.com/api/v1/company-authority",
    "https://localhost",
    "https://127.0.0.1",
    "https://10.0.0.1",
    "https://169.254.169.254",
    "https://172.16.0.1",
    "https://192.168.0.1",
    "https://[::1]",
    "https://[fd00::1]",
    "https://[fe80::1]",
    "https://[::ffff:127.0.0.1]",
    "https://[ff02::1]",
    "not a url",
  ])("rejects unsafe authority base URL %s", (baseUrl) => {
    expectInvalid({ ...validEnv(), BRAINBASE_COMPANY_AUTHORITY_BASE_URL: baseUrl });
  });

  it.each([
    "not-json",
    JSON.stringify({ ...publicJwk, d: "private-material" }),
    JSON.stringify({ ...publicJwk, alg: "ES256" }),
    JSON.stringify({ ...publicJwk, key_ops: ["sign"] }),
    JSON.stringify({ ...publicJwk, key_ops: ["verify", "sign"] }),
    JSON.stringify({ kty: "RSA", n: "n", e: "AQAB" }),
    JSON.stringify({ kty: "OKP", crv: "Ed25519" }),
    JSON.stringify({ keys: [publicJwk] }),
  ])("rejects invalid public JWK %s", (jwk) => {
    expectInvalid({ ...validEnv(), BRAINBASE_COMPANY_AUTHORITY_PUBLIC_JWK_JSON: jwk });
  });

  it.each([
    JSON.stringify({}),
    JSON.stringify({ "task.read": "delete" }),
    JSON.stringify({ "": "read" }),
    JSON.stringify({ company_authority_v1: "read" }),
    JSON.stringify(["task.read"]),
    JSON.stringify("task.read"),
  ])("rejects invalid operation map %s", (operations) => {
    expectInvalid({ ...validEnv(), MANA_COMPANY_AUTHORITY_OPERATIONS_JSON: operations });
  });

  it.each([
    JSON.stringify({ keys: [] }),
    JSON.stringify({ keys: [{ ...publicJwk, kid: "one" }, { ...publicJwk, kid: "two" }] }),
    JSON.stringify({ keys: [{ ...publicJwk }] }),
    JSON.stringify({ keys: [{ ...publicJwk, kid: "tenant-key-1", d: "private" }] }),
    JSON.stringify({ keys: [{ ...publicJwk, kid: "tenant-key-1", alg: "RS256" }] }),
    JSON.stringify({ keys: [{ ...publicJwk, kid: "tenant-key-1", key_ops: ["sign"] }] }),
  ])("rejects ambiguous or invalid tenant verification JWKS %s", (jwks) => {
    expectInvalid({ ...validEnv(), BRAINBASE_TENANT_CONTEXT_JWKS_JSON: jwks });
  });

  it("derives the enabled trust contract only from environment configuration", () => {
    expect(parseCompanyAuthorityRuntimeConfiguration(validEnv())).toEqual({
      state: "enabled",
      base_url: "https://authority.example.com",
      opted_in_capability_ids: ["slack.post", "task.read", "task.write"],
      desired_effect_by_capability: {
        "slack.post": "external_side_effect",
        "task.read": "read",
        "task.write": "write",
      },
      acceptance: {
        expected_audience: "mana-runtime",
        expected_deployment_id: "dep_trusted",
        public_jwk: publicJwk,
        tenant_context_public_jwk: { ...publicJwk, kid: "tenant-key-1" },
        tenant_context_key_id: "tenant-key-1",
      },
    });
  });

  it("canonicalizes an accepted authority origin", () => {
    expect(parseCompanyAuthorityRuntimeConfiguration({
      ...validEnv(),
      BRAINBASE_COMPANY_AUTHORITY_BASE_URL: "https://AUTHORITY.EXAMPLE.COM:443/",
    })).toMatchObject({
      state: "enabled",
      base_url: "https://authority.example.com",
    });
  });
});
