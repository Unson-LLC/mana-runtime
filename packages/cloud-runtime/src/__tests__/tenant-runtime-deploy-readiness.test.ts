import { describe, expect, it, vi } from "vitest";

import {
  assessTenantRuntimeDeploymentConfig,
  assertTenantRuntimeDeploymentConfig,
  assertTenantRuntimeDeploymentPreflight,
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

const deploymentTarget = "mana-test";
const deploymentCandidateCommit = "4".repeat(40);
const deploymentNow = "2026-08-21T00:00:00.000Z";
const deploymentAuthorization = {
  reviewer_identity: "github:reviewer",
  reviewer_provenance: "github:pull_request_review",
  reviewed_commit_sha: deploymentCandidateCommit,
  target: deploymentTarget,
  authorized_at: "2026-08-20T00:00:00.000Z",
  expires_at: "2026-08-22T00:00:00.000Z",
};

const completeConfig = {
  name: deploymentTarget,
  vars: {
    TENANT_ID: "unson-business",
    MANA_DEPLOYMENT_PROFILE: "shared_cloud",
    SLACK_EXPECTED_APP_ID: "A-MANA",
    SLACK_OAUTH_APP_ID: "A-MANA",
    SLACK_OAUTH_CLIENT_ID: "client-test",
    SLACK_OAUTH_REDIRECT_URI: "https://mana.example.test/slack/installations/oauth/callback",
    SLACK_OAUTH_SCOPES: "app_mentions:read,chat:write",
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
  services: [
    { binding: "BRAINBASE_TENANT_RUNTIME_SERVICE", service: "brainbase-tenant-runtime" },
    { binding: "SLACK_INSTALLATION_CONTROL_PLANE", service: "brainbase-slack-installation-control-plane" },
  ],
  durable_objects: {
    bindings: [{ name: "TENANT_RUNTIME_STATE", class_name: "TenantRuntimeState" }],
  },
  migrations: [{ tag: "v1", new_sqlite_classes: ["TenantRuntimeState"] }],
};

const completeSecrets = [
  "BRAINBASE_RUNTIME_API_TOKEN",
  "BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_INSTALLATION_LIFECYCLE_TOKEN",
  "DEVELOPMENT_CALLBACK_TOKEN",
];

const sourceLockPaths = {
  tenantContext: "/canonical/contracts/mana-brainbase-tenant-context/v1/source-lock.json",
  trustedProviderForwarder: "/canonical/contracts/brainbase-trusted-provider-forwarder/v1/source-lock.json",
};

const tenantContextSourceLock = {
  schema_version: "1.0",
  kit_role: "canonical_conformance_contract",
  cross_contract: {
    repository: "Unson-LLC/mana-runtime",
    pull_request: 292,
    input_head: "1".repeat(40),
  },
  producer_audit_input: {
    repository: "Unson-LLC/brainbase-unson",
    pull_request: 1257,
    head: "2".repeat(40),
  },
  consumer_audit_input: {
    repository: "Unson-LLC/mana-runtime",
    pull_request: 292,
    head: "1".repeat(40),
  },
  fixture_set_sha256: "3".repeat(64),
  production_code_changed: true,
  merge_allowed: true,
  deploy_allowed: true,
  deployment_authorization: deploymentAuthorization,
};

const trustedProviderForwarderSourceLock = {
  schema_version: "1.0",
  contract_role: "brainbase_trusted_provider_forwarder_consumer",
  producer: {
    repository: "Unson-LLC/brainbase-unson",
    pull_request: 1229,
    head: "4".repeat(40),
    files: {
      "src/index.ts": "5".repeat(64),
    },
  },
  tenant_context_contract: {
    repository: "Unson-LLC/mana-runtime",
    pull_request: 292,
    current_head: "1".repeat(40),
    fixture_set_sha256: "3".repeat(64),
  },
  wire: {
    method: "POST",
    path: "/api/v1/runtime/provider-requests:forward",
    protocol_version: "1.0",
    configuration: {
      enabled_env: "BRAINBASE_TENANT_RUNTIME_ENABLED",
      enabled_value: "1",
      host_env: "BRAINBASE_TENANT_RUNTIME_HOST",
      default_host: "127.0.0.1",
      port_env: "BRAINBASE_TENANT_RUNTIME_PORT",
      explicit_port_required: true,
      non_loopback_opt_in_env: "BRAINBASE_TENANT_RUNTIME_ALLOW_NON_LOOPBACK",
      wildcard_bind_allowed_by_default: false,
      service_token_env: "BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN",
    },
    headers: {
      Authorization: "Bearer ${BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN}",
      "Brainbase-Protocol-Version": "1.0",
      "Brainbase-Deployment-Id": "${tenant_context.placement.deployment_id}",
      "Content-Type": "application/json",
    },
    idempotency_key_pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$",
    request_fields: ["tenant_context", "lease_id", "lease_token", "audience", "provider_operation", "request"],
    request_optional_fields: ["path_params", "query", "body", "target_url", "idempotency_key"],
    response_fields: ["provider", "operation_id", "provider_operation", "status", "response_encoding", "content_type", "body"],
    response_encoding_values: ["json", "utf8", "base64"],
    canonical_error_codes: [
      "SCHEMA_INVALID",
      "SERVICE_AUTH_REQUIRED",
      "CREDENTIAL_LEASE_SCOPE_MISMATCH",
      "CREDENTIAL_LEASE_ALREADY_USED",
      "UPSTREAM_INVALID_RESPONSE",
      "UPSTREAM_UNAVAILABLE",
    ],
  },
  security: {
    raw_credential_returned_to_consumer: false,
    credential_reflection_rejected: true,
    provider_auth_headers_owned_by: "brainbase_trusted_service",
    consumer_fallback_allowed: false,
  },
  merge_allowed: true,
  deploy_allowed: true,
  deployment_authorization: deploymentAuthorization,
};

const deploymentAuthorizationContext = {
  deploymentTarget,
  candidateCommit: deploymentCandidateCommit,
  now: deploymentNow,
};

function preflightDependencies(overrides: Record<string, unknown> = {}) {
  const files = new Map<string, string>([
    ["/deploy/wrangler.jsonc", JSON.stringify(completeConfig)],
    [sourceLockPaths.tenantContext, JSON.stringify(tenantContextSourceLock)],
    [sourceLockPaths.trustedProviderForwarder, JSON.stringify(trustedProviderForwarderSourceLock)],
  ]);
  for (const [path, value] of Object.entries(overrides)) {
    if (value === undefined) files.delete(path);
    else files.set(path, JSON.stringify(value));
  }
  return {
    sourceLockPaths,
    readFileImpl: vi.fn(async (path: string) => {
      const content = files.get(String(path));
      if (content === undefined) throw new Error("ENOENT secret-material-never-log");
      return content;
    }),
    execFileImpl: vi.fn(async () => ({
      stdout: JSON.stringify(completeSecrets.map((name) => ({ name, type: "secret_text" }))),
    })),
  };
}

describe("tenant runtime deploy readiness", () => {
  it.each([
    ["false", {
    [sourceLockPaths.tenantContext]: { ...tenantContextSourceLock, deploy_allowed: false },
    }, "tenant_runtime_source_lock_preflight_failed:tenant_context:deploy_not_allowed"],
    ["false in trusted forwarder", {
      [sourceLockPaths.trustedProviderForwarder]: {
        ...trustedProviderForwarderSourceLock,
        deploy_allowed: false,
      },
    }, "tenant_runtime_source_lock_preflight_failed:trusted_provider_forwarder:deploy_not_allowed"],
    ["missing", {
      [sourceLockPaths.trustedProviderForwarder]: undefined,
    }, "tenant_runtime_source_lock_preflight_failed:trusted_provider_forwarder:missing"],
    ["missing deploy_allowed", {
      [sourceLockPaths.trustedProviderForwarder]: {
        ...trustedProviderForwarderSourceLock,
        deploy_allowed: undefined,
      },
    }, "tenant_runtime_source_lock_preflight_failed:trusted_provider_forwarder:invalid"],
    ["invalid", {
      [sourceLockPaths.tenantContext]: {
        ...tenantContextSourceLock,
        fixture_set_sha256: "secret-material-never-log",
      },
    }, "tenant_runtime_source_lock_preflight_failed:tenant_context:invalid"],
    ["stale", {
      [sourceLockPaths.trustedProviderForwarder]: {
        ...trustedProviderForwarderSourceLock,
        tenant_context_contract: {
          ...trustedProviderForwarderSourceLock.tenant_context_contract,
          current_head: "6".repeat(40),
        },
      },
    }, "tenant_runtime_source_lock_preflight_failed:cross_contract:stale"],
  ])("fails closed before Cloudflare access when a canonical source lock is %s", async (_case, overrides, expectedError) => {
    const dependencies = preflightDependencies(overrides);

    const attempt = assertTenantRuntimeDeploymentPreflight({
      configPath: "/deploy/wrangler.jsonc",
      ...dependencies,
      ...deploymentAuthorizationContext,
    });

    await expect(attempt).rejects.toThrow(expectedError);
    await expect(attempt).rejects.not.toThrow("secret-material-never-log");
    expect(dependencies.execFileImpl).not.toHaveBeenCalled();
    expect(dependencies.readFileImpl).toHaveBeenCalledWith(sourceLockPaths.tenantContext, "utf8");
    expect(dependencies.readFileImpl).toHaveBeenCalledWith(sourceLockPaths.trustedProviderForwarder, "utf8");
  });

  it("consults Cloudflare only after both canonical source locks pass schema and freshness checks", async () => {
    const dependencies = preflightDependencies();

    await expect(assertTenantRuntimeDeploymentPreflight({
      configPath: "/deploy/wrangler.jsonc",
      ...dependencies,
      ...deploymentAuthorizationContext,
    })).resolves.toMatchObject({ tenantId: "unson-business" });

    expect(dependencies.execFileImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", undefined, deploymentAuthorizationContext,
      "tenant_runtime_source_lock_preflight_failed:tenant_context:deployment_authorization_missing"],
    ["expired", { ...deploymentAuthorization, expires_at: deploymentNow }, deploymentAuthorizationContext,
      "tenant_runtime_source_lock_preflight_failed:tenant_context:deployment_authorization_expired"],
    ["future-dated", { ...deploymentAuthorization, authorized_at: "2026-08-21T00:00:00.001Z" }, deploymentAuthorizationContext,
      "tenant_runtime_source_lock_preflight_failed:tenant_context:deployment_authorization_invalid"],
    ["target mismatch", { ...deploymentAuthorization, target: "other-target" }, deploymentAuthorizationContext,
      "tenant_runtime_source_lock_preflight_failed:tenant_context:deployment_authorization_target_mismatch"],
    ["candidate mismatch", { ...deploymentAuthorization, reviewed_commit_sha: "9".repeat(40) }, deploymentAuthorizationContext,
      "tenant_runtime_source_lock_preflight_failed:tenant_context:deployment_authorization_candidate_mismatch"],
  ])("rejects %s deployment authorization before Cloudflare access", async (_case, authorization, context, expectedError) => {
    const dependencies = preflightDependencies({
      [sourceLockPaths.tenantContext]: {
        ...tenantContextSourceLock,
        deployment_authorization: authorization,
      },
    });

    await expect(assertTenantRuntimeDeploymentPreflight({
      configPath: "/deploy/wrangler.jsonc",
      ...dependencies,
      ...context,
    })).rejects.toThrow(expectedError);
    expect(dependencies.execFileImpl).not.toHaveBeenCalled();
  });

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
        "SLACK_INSTALLATION_CONTROL_PLANE",
        "TENANT_RUNTIME_STATE",
      ],
    });
  });

  it("rejects private JWK material and redirected canonical Service Bindings", () => {
    const config = structuredClone(completeConfig);
    config.vars.BRAINBASE_TENANT_CONTEXT_JWKS_JSON = JSON.stringify({
      keys: [{ kty: "OKP", crv: "Ed25519", kid: "key-1", x: "public-key", d: "private-never-log" }],
    });
    config.services = [
      { binding: "BRAINBASE_TENANT_RUNTIME_SERVICE", service: "other-runtime" },
      { binding: "SLACK_INSTALLATION_CONTROL_PLANE", service: "other-control-plane" },
    ];

    expect(assessTenantRuntimeDeploymentConfig(config, completeSecrets)).toEqual({
      ready: false,
      missing_bindings: [
        "BRAINBASE_TENANT_CONTEXT_JWKS_JSON",
        "BRAINBASE_TENANT_RUNTIME_SERVICE",
        "SLACK_INSTALLATION_CONTROL_PLANE",
      ],
    });
  });

  it("requires OAuth public configuration, the control-plane Service Binding, and the state migration", () => {
    const config = structuredClone(completeConfig);
    for (const name of [
      "SLACK_OAUTH_APP_ID",
      "SLACK_OAUTH_CLIENT_ID",
      "SLACK_OAUTH_REDIRECT_URI",
      "SLACK_OAUTH_SCOPES",
    ]) {
      delete (config.vars as Record<string, unknown>)[name];
    }
    config.services = config.services.filter((binding) => binding.binding !== "SLACK_INSTALLATION_CONTROL_PLANE");
    config.migrations = [];

    expect(assessTenantRuntimeDeploymentConfig(config, completeSecrets)).toEqual({
      ready: false,
      missing_bindings: [
        "SLACK_INSTALLATION_CONTROL_PLANE",
        "SLACK_OAUTH_APP_ID",
        "SLACK_OAUTH_CLIENT_ID",
        "SLACK_OAUTH_REDIRECT_URI",
        "SLACK_OAUTH_SCOPES",
        "TENANT_RUNTIME_STATE_MIGRATION",
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

  it("requires the expected Slack app ID in the deployment preflight", () => {
    const config = structuredClone(completeConfig);
    delete (config.vars as Record<string, unknown>).SLACK_EXPECTED_APP_ID;

    expect(assessTenantRuntimeDeploymentConfig(config, completeSecrets)).toEqual({
      ready: false,
      missing_bindings: ["SLACK_EXPECTED_APP_ID"],
    });
    expect(() => assertTenantRuntimeDeploymentConfig(config, completeSecrets))
      .toThrow("tenant_runtime_deploy_preflight_failed:SLACK_EXPECTED_APP_ID");
  });

  it("accepts a complete deployment config and parses Wrangler secret metadata", () => {
    const output = JSON.stringify(completeSecrets.map((name) => ({ name, type: "secret_text" })));
    expect(parseWranglerSecretNames(output)).toEqual([...completeSecrets].sort());
    expect(assertTenantRuntimeDeploymentConfig(completeConfig, parseWranglerSecretNames(output))).toEqual({
      ready: true,
      missing_bindings: [],
    });
  });

  it("does not require legacy Brainbase URL vars because runtime calls the Service Binding", () => {
    const config = structuredClone(completeConfig);
    for (const name of [
      "BRAINBASE_TENANT_AUTHORITY_URL",
      "BRAINBASE_CREDENTIAL_BROKER_URL",
      "BRAINBASE_QUOTA_URL",
      "BRAINBASE_ACCOUNTING_URL",
    ]) {
      (config.vars as Record<string, unknown>)[name] = "not-a-url";
    }

    expect(assessTenantRuntimeDeploymentConfig(config, completeSecrets)).toEqual({
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
