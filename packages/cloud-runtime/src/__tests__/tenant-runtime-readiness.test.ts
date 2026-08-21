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
  BRAINBASE_RUNTIME_API_TOKEN: "opaque-test-token",
  BRAINBASE_TENANT_RUNTIME_ENABLED: "1",
  BRAINBASE_TENANT_RUNTIME_HOST: "127.0.0.1",
  BRAINBASE_TENANT_RUNTIME_PORT: "31016",
  BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN: "internal-service-token-placeholder",
  BRAINBASE_TENANT_RUNTIME_SERVICE: { fetch: async () => new Response() },
  SLACK_SIGNING_SECRET: "slack-signing-secret-placeholder",
  SLACK_INSTALLATION_LIFECYCLE_TOKEN: "installation-lifecycle-test-placeholder",
  SLACK_EXPECTED_APP_ID: "A-MANA",
  SLACK_OAUTH_APP_ID: "A-MANA",
  SLACK_OAUTH_CLIENT_ID: "client-test",
  SLACK_OAUTH_REDIRECT_URI: "https://mana.example.test/slack/installations/oauth/callback",
  SLACK_OAUTH_SCOPES: "app_mentions:read,chat:write",
  SLACK_INSTALLATION_CONTROL_PLANE: { fetch: async () => new Response() },
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
      BRAINBASE_QUOTA_URL: "http://unsafe.example.test",
      TENANT_RUNTIME_STATE: undefined,
    });
    expect(result).toEqual({
      ready: false,
      missing_bindings: [
        "TENANT_RUNTIME_STATE",
      ],
    });
    expect(JSON.stringify(result)).not.toContain("opaque-test-token");
  });

  it("does not require legacy Brainbase URL variables when Service Bindings are used", () => {
    expect(assessTenantRuntimeReadiness({
      ...complete,
      BRAINBASE_TENANT_AUTHORITY_URL: undefined,
      BRAINBASE_CREDENTIAL_BROKER_URL: "http://unused.example.test",
      BRAINBASE_QUOTA_URL: undefined,
      BRAINBASE_ACCOUNTING_URL: "not-a-url",
    })).toEqual({ ready: true, missing_bindings: [] });
  });

  it("rejects a tenant-context JWKS containing private key material", () => {
    expect(assessTenantRuntimeReadiness({
      ...complete,
      BRAINBASE_TENANT_CONTEXT_JWKS_JSON: JSON.stringify({
        keys: [{ kty: "OKP", crv: "Ed25519", kid: "key-1", x: "public-key", d: "private-never-log" }],
      }),
    })).toEqual({ ready: false, missing_bindings: ["BRAINBASE_TENANT_CONTEXT_JWKS_JSON"] });
  });

  it("requires a fetch-only Slack installation control-plane binding", () => {
    expect(assessTenantRuntimeReadiness({
      ...complete,
      SLACK_INSTALLATION_CONTROL_PLANE: {
        authorize: async () => ({}),
        exchange_and_register: async () => ({}),
      },
    })).toEqual({
      ready: false,
      missing_bindings: ["SLACK_INSTALLATION_CONTROL_PLANE"],
    });
    expect(assessTenantRuntimeReadiness({
      ...complete,
      SLACK_INSTALLATION_CONTROL_PLANE: { fetch: async () => new Response() },
    })).toEqual({ ready: true, missing_bindings: [] });
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

  it("fails closed when the public Slack signing secret is not configured", () => {
    expect(assessTenantRuntimeReadiness({
      ...complete,
      SLACK_SIGNING_SECRET: undefined,
    })).toEqual({
      ready: false,
      missing_bindings: ["SLACK_SIGNING_SECRET"],
    });
  });

  it("fails closed when Slack OAuth configuration or its control plane is not configured", () => {
    expect(assessTenantRuntimeReadiness({
      ...complete,
      SLACK_OAUTH_APP_ID: undefined,
      SLACK_OAUTH_CLIENT_ID: undefined,
      SLACK_OAUTH_REDIRECT_URI: undefined,
      SLACK_OAUTH_SCOPES: undefined,
      SLACK_INSTALLATION_CONTROL_PLANE: undefined,
    })).toEqual({
      ready: false,
      missing_bindings: [
        "SLACK_INSTALLATION_CONTROL_PLANE",
        "SLACK_OAUTH_APP_ID",
        "SLACK_OAUTH_CLIENT_ID",
        "SLACK_OAUTH_REDIRECT_URI",
        "SLACK_OAUTH_SCOPES",
      ],
    });
  });

  it("requires an HTTPS OAuth redirect URI and at least one valid OAuth scope", () => {
    expect(assessTenantRuntimeReadiness({
      ...complete,
      SLACK_OAUTH_REDIRECT_URI: "http://mana.example.test/callback",
      SLACK_OAUTH_SCOPES: "",
    })).toEqual({
      ready: false,
      missing_bindings: ["SLACK_OAUTH_REDIRECT_URI", "SLACK_OAUTH_SCOPES"],
    });
  });

  it("requires a dedicated safe Brainbase provider-forward binding", () => {
    expect(assessTenantRuntimeReadiness({
      ...complete,
      BRAINBASE_TENANT_RUNTIME_ENABLED: undefined,
      BRAINBASE_TENANT_RUNTIME_PORT: undefined,
      BRAINBASE_TENANT_RUNTIME_SERVICE: undefined,
    })).toEqual({
      ready: false,
      missing_bindings: [
        "BRAINBASE_TENANT_RUNTIME_ENABLED",
        "BRAINBASE_TENANT_RUNTIME_PORT",
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
    expect(assessTenantRuntimeReadiness({
      ...complete,
      BRAINBASE_TENANT_RUNTIME_HOST: "*",
      BRAINBASE_TENANT_RUNTIME_ALLOW_NON_LOOPBACK: "1",
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
