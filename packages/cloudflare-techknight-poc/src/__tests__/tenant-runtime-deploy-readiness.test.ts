import { describe, expect, it, vi } from "vitest";

import {
  assessTenantRuntimeDeploymentConfig,
  assertTenantRuntimeDeploymentConfig,
  assertTenantRuntimeHealthReady,
  parseWranglerSecretNames,
} from "../../scripts/tenant-runtime-deploy-readiness.mjs";

const requiredCapabilities = [
  "signed_tenant_context",
  "connection_revision_recheck",
  "tenant_scoped_authorization",
  "credential_broker_v1",
  "usage_receipt_v1",
  "idempotent_effects_v1",
  "container_sanitization_v1",
].join(",");

const completeConfig = {
  vars: {
    TENANT_ID: "unson-business",
    MANA_DEPLOYMENT_PROFILE: "shared_cloud",
    MANA_REQUIRED_AUDIENCE: "mana-runtime",
    MANA_REQUIRED_PROJECT_ID: "mana",
    MANA_REQUIRED_CAPABILITY_ID: "runtime.execute",
    MANA_REQUIRED_SLACK_SCOPES: "app_mentions:read,chat:write",
    MANA_CREDENTIAL_AUDIENCE: "api.anthropic.com",
    MANA_RUNTIME_CAPABILITIES: requiredCapabilities,
    BRAINBASE_TENANT_AUTHORITY_URL: "https://bb.example.test/tenant-authority",
    BRAINBASE_CREDENTIAL_BROKER_URL: "https://bb.example.test/credential-broker",
    BRAINBASE_QUOTA_URL: "https://bb.example.test/quota",
    BRAINBASE_ACCOUNTING_URL: "https://bb.example.test/accounting",
    BRAINBASE_TENANT_RUNTIME_ENABLED: "1",
    BRAINBASE_TENANT_RUNTIME_HOST: "127.0.0.1",
    BRAINBASE_TENANT_RUNTIME_PORT: "31016",
    BRAINBASE_TENANT_CONTEXT_JWKS_JSON: JSON.stringify({
      keys: [{ kty: "OKP", crv: "Ed25519", kid: "key-1", x: "public-key", use: "sig" }],
    }),
    RUNTIME_PLACEMENTS_JSON: JSON.stringify([{ developmentEnabled: true }]),
    DEVELOPMENT_CALLBACK_BASE_URL: "https://mana.example.test",
  },
  services: [{ binding: "BRAINBASE_TENANT_RUNTIME_SERVICE", service: "brainbase-tenant-runtime" }],
  durable_objects: {
    bindings: [{ name: "TENANT_RUNTIME_STATE", class_name: "TenantRuntimeState" }],
  },
};

const completeSecrets = [
  "BRAINBASE_RUNTIME_API_TOKEN",
  "BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_INSTALLATION_LIFECYCLE_TOKEN",
  "DEVELOPMENT_CALLBACK_TOKEN",
];

describe("tenant runtime deploy readiness", () => {
  it("fails closed for missing public vars, JWKS, Service Binding, and Durable Object binding", () => {
    const config = structuredClone(completeConfig);
    delete (config.vars as Record<string, unknown>).MANA_REQUIRED_AUDIENCE;
    delete (config.vars as Record<string, unknown>).BRAINBASE_TENANT_CONTEXT_JWKS_JSON;
    config.services = [];
    config.durable_objects.bindings = [];

    expect(assessTenantRuntimeDeploymentConfig(config, completeSecrets)).toEqual({
      ready: false,
      missing_bindings: [
        "BRAINBASE_TENANT_CONTEXT_JWKS_JSON",
        "BRAINBASE_TENANT_RUNTIME_SERVICE",
        "MANA_REQUIRED_AUDIENCE",
        "TENANT_RUNTIME_STATE",
      ],
    });
  });

  it("reports missing secret binding names without exposing configured material", () => {
    const result = assessTenantRuntimeDeploymentConfig(completeConfig, [
      "BRAINBASE_RUNTIME_API_TOKEN",
      "SLACK_INSTALLATION_LIFECYCLE_TOKEN",
    ]);

    expect(result).toEqual({
      ready: false,
      missing_bindings: [
        "BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN",
        "DEVELOPMENT_CALLBACK_TOKEN",
        "SLACK_SIGNING_SECRET",
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret-material-never-log");
  });

  it("requires the signing secret used by the public Slack ingress", () => {
    const result = assessTenantRuntimeDeploymentConfig(completeConfig, completeSecrets.filter((name) => name !== "SLACK_SIGNING_SECRET"));

    expect(result).toEqual({
      ready: false,
      missing_bindings: ["SLACK_SIGNING_SECRET"],
    });
  });

  it("accepts a complete deployment config and parses Wrangler secret metadata", () => {
    const output = JSON.stringify(completeSecrets.map((name) => ({ name, type: "secret_text" })));
    expect(parseWranglerSecretNames(output)).toEqual([...completeSecrets].sort());
    expect(assertTenantRuntimeDeploymentConfig(completeConfig, parseWranglerSecretNames(output))).toEqual({
      ready: true,
      missing_bindings: [],
    });
  });

  it("rejects a non-ready post-deploy health response using binding names only", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      ok: false,
      tenant: "unson-business",
      tenant_runtime: { ready: false, missing_bindings: ["BRAINBASE_TENANT_CONTEXT_JWKS_JSON"] },
      diagnostic: "secret-material-never-log",
    }, { status: 503 }));

    await expect(assertTenantRuntimeHealthReady({
      baseUrl: "https://mana.example.test",
      expectedTenantId: "unson-business",
      fetchImpl,
    })).rejects.toThrow("tenant_runtime_post_deploy_not_ready:BRAINBASE_TENANT_CONTEXT_JWKS_JSON");
  });

  it("accepts only a matching tenant with ready post-deploy health", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      ok: true,
      tenant: "unson-business",
      tenant_runtime: { ready: true, missing_bindings: [] },
    }));

    await expect(assertTenantRuntimeHealthReady({
      baseUrl: "https://mana.example.test",
      expectedTenantId: "unson-business",
      fetchImpl,
    })).resolves.toMatchObject({ ok: true, tenant: "unson-business" });
    expect(fetchImpl).toHaveBeenCalledWith(new URL("https://mana.example.test/health"), expect.objectContaining({
      method: "GET",
      redirect: "error",
    }));
  });
});
