import { describe, expect, it } from "vitest";

import { assessTenantRuntimeReadiness } from "../multitenancy/runtime-readiness.js";

const complete = {
  MANA_DEPLOYMENT_PROFILE: "shared_cloud",
  MANA_REQUIRED_AUDIENCE: "mana-runtime",
  MANA_REQUIRED_PROJECT_ID: "project_a",
  MANA_REQUIRED_CAPABILITY_ID: "runtime.execute",
  MANA_REQUIRED_SLACK_SCOPES: "app_mentions:read,chat:write",
  MANA_CREDENTIAL_AUDIENCE: "api.anthropic.com",
  MANA_RUNTIME_CAPABILITIES: [
    "signed_tenant_context",
    "connection_revision_recheck",
    "tenant_scoped_authorization",
    "credential_broker_v1",
    "usage_receipt_v1",
    "idempotent_effects_v1",
    "container_sanitization_v1",
  ].join(","),
  BRAINBASE_TENANT_AUTHORITY_URL: "https://authority.example.test",
  BRAINBASE_CREDENTIAL_BROKER_URL: "https://broker.example.test",
  BRAINBASE_QUOTA_URL: "https://quota.example.test",
  BRAINBASE_ACCOUNTING_URL: "https://accounting.example.test",
  BRAINBASE_RUNTIME_API_TOKEN: "opaque-test-token",
  BRAINBASE_TENANT_RUNTIME_ENABLED: "1",
  BRAINBASE_TENANT_RUNTIME_HOST: "127.0.0.1",
  BRAINBASE_TENANT_RUNTIME_PORT: "31016",
  BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: "internal-service-token-placeholder",
  BRAINBASE_TENANT_RUNTIME_SERVICE: { fetch: async () => new Response() },
  SLACK_INSTALLATION_LIFECYCLE_TOKEN: "installation-lifecycle-test-placeholder",
  SLACK_EXPECTED_APP_ID: "A-MANA",
  BRAINBASE_TENANT_CONTEXT_JWKS_JSON: JSON.stringify({
    keys: [{ kty: "OKP", crv: "Ed25519", kid: "key-1", x: "test", use: "sig" }],
  }),
  TENANT_RUNTIME_STATE: {},
};

describe("tenant runtime readiness", () => {
  it("reports ready only when the canonical consumer bindings are present", () => {
    expect(assessTenantRuntimeReadiness(complete)).toEqual({ ready: true, missing_bindings: [] });
  });

  it("returns binding names only and never secret values", () => {
    const result = assessTenantRuntimeReadiness({
      ...complete,
      BRAINBASE_RUNTIME_API_TOKEN: "",
      BRAINBASE_QUOTA_URL: "http://unsafe.example.test",
      TENANT_RUNTIME_STATE: undefined,
    });
    expect(result).toEqual({
      ready: false,
      missing_bindings: [
        "BRAINBASE_QUOTA_URL",
        "BRAINBASE_RUNTIME_API_TOKEN",
        "TENANT_RUNTIME_STATE",
      ],
    });
    expect(JSON.stringify(result)).not.toContain("opaque-test-token");
  });

  it("fails closed when installation lifecycle authentication is not configured", () => {
    expect(assessTenantRuntimeReadiness({
      ...complete,
      SLACK_INSTALLATION_LIFECYCLE_TOKEN: undefined,
    })).toEqual({
      ready: false,
      missing_bindings: ["SLACK_INSTALLATION_LIFECYCLE_TOKEN"],
    });
  });

  it("requires a dedicated safe Brainbase provider-forward binding", () => {
    expect(assessTenantRuntimeReadiness({
      ...complete,
      BRAINBASE_TENANT_RUNTIME_ENABLED: undefined,
      BRAINBASE_TENANT_RUNTIME_PORT: undefined,
      BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: undefined,
      BRAINBASE_TENANT_RUNTIME_SERVICE: undefined,
    })).toEqual({
      ready: false,
      missing_bindings: [
        "BRAINBASE_TENANT_RUNTIME_ENABLED",
        "BRAINBASE_TENANT_RUNTIME_PORT",
        "BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN",
        "BRAINBASE_TENANT_RUNTIME_SERVICE",
      ],
    });
    expect(assessTenantRuntimeReadiness({
      ...complete,
      BRAINBASE_TENANT_RUNTIME_HOST: "0.0.0.0",
    })).toEqual({
      ready: false,
      missing_bindings: ["BRAINBASE_TENANT_RUNTIME_HOST"],
    });
  });

  it("requires a service actor whenever TaskBoard scheduling is enabled", () => {
    expect(assessTenantRuntimeReadiness({
      ...complete,
      RUNTIME_TASK_BOARD_ENABLED: "true",
      TASK_BOARD_TARGETS_JSON: "[]",
    })).toEqual({
      ready: false,
      missing_bindings: ["MANA_TASK_BOARD_SERVICE_ACTOR_ID"],
    });
    expect(assessTenantRuntimeReadiness({
      ...complete,
      TASK_BOARD_TARGETS_JSON: "[]",
    })).toEqual({
      ready: false,
      missing_bindings: ["MANA_TASK_BOARD_SERVICE_ACTOR_ID"],
    });
  });

  it("requires canonical TaskBoard targets whenever scheduling is enabled", () => {
    expect(assessTenantRuntimeReadiness({
      ...complete,
      RUNTIME_TASK_BOARD_ENABLED: "true",
      MANA_TASK_BOARD_SERVICE_ACTOR_ID: "service_task_board",
    })).toEqual({
      ready: false,
      missing_bindings: ["TASK_BOARD_TARGETS_JSON"],
    });
  });

  it("fails health closed when an enabled development placement cannot receive terminal callbacks", () => {
    expect(assessTenantRuntimeReadiness({
      ...complete,
      RUNTIME_PLACEMENTS_JSON: JSON.stringify([{ developmentEnabled: true }]),
    })).toEqual({
      ready: false,
      missing_bindings: ["DEVELOPMENT_CALLBACK_BASE_URL", "DEVELOPMENT_CALLBACK_TOKEN"],
    });
    expect(assessTenantRuntimeReadiness({
      ...complete,
      RUNTIME_PLACEMENTS_JSON: JSON.stringify([{ developmentEnabled: true }]),
      DEVELOPMENT_CALLBACK_BASE_URL: "https://runtime.example.test",
      DEVELOPMENT_CALLBACK_TOKEN: "opaque-callback-token",
    })).toEqual({ ready: true, missing_bindings: [] });
  });
});
