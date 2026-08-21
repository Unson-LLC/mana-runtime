import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assessTenantRuntimeDeploymentConfig } from "../../scripts/tenant-runtime-deploy-readiness.mjs";
import type { CustomerManagedDeploymentManifest } from "../../scripts/deployment-manifest.d.mts";

const REQUIRED_CAPABILITIES = [
  "signed_tenant_context",
  "connection_revision_recheck",
  "tenant_scoped_authorization",
  "credential_broker_v1",
  "usage_receipt_v1",
  "idempotent_effects_v1",
  "container_sanitization_v1",
];

interface WranglerProfile {
  account_id?: string;
  name: string;
  main: string;
  vars: Record<string, string>;
  services: Array<{ binding: string; service: string }>;
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
  queues: {
    producers: Array<{ queue: string }>;
    consumers: Array<{ queue: string; dead_letter_queue: string; max_retries: number }>;
  };
}

function packageFile(path: string): string {
  return fileURLToPath(new URL(`../../${path}`, import.meta.url));
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(packageFile(path), "utf8")) as T;
}

function expectCommonTenantContract(config: WranglerProfile, profile: string): void {
  expect(config.main).toBe("src/index.ts");
  expect(config.vars.MANA_DEPLOYMENT_PROFILE).toBe(profile);
  expect(config.vars.MANA_RUNTIME_CAPABILITIES.split(",")).toEqual(
    expect.arrayContaining(REQUIRED_CAPABILITIES),
  );
  expect(config.services).toContainEqual({
    binding: "BRAINBASE_TENANT_RUNTIME_SERVICE",
    service: "brainbase-tenant-runtime",
  });
  expect(config.services).toContainEqual({
    binding: "SLACK_INSTALLATION_CONTROL_PLANE",
    service: "brainbase-slack-installation-control-plane",
  });
  expect(config.durable_objects.bindings).toContainEqual({
    name: "TENANT_RUNTIME_STATE",
    class_name: "TenantRuntimeState",
  });
  expect(config.migrations).toEqual(expect.arrayContaining([
    { tag: expect.any(String), new_sqlite_classes: ["TenantRuntimeState"] },
  ]));
}

describe("実配置profileのビルド契約", () => {
  it("shared、dedicated、customer-managed OSSを同じbuild入口で検証する", () => {
    const packageJson = loadJson<{ scripts: Record<string, string> }>("package.json");
    const buildProfiles = readFileSync(packageFile("scripts/build-profiles.mjs"), "utf8");

    expect(buildProfiles).toContain(
      '["build:default", "build:unson-business", "build:dedicated-cloud", "build:customer-managed-oss"]',
    );
    expect(packageJson.scripts["build:dedicated-cloud"]).toContain(
      "wrangler.dedicated-cloud.jsonc --dry-run",
    );
    expect(packageJson.scripts["build:customer-managed-oss"]).toContain(
      "scripts/build-customer-managed-oss.mjs",
    );
  });

  it("dedicated_cloudを固有Worker、Queue、DLQでdry-run可能にする", () => {
    const config = loadJson<WranglerProfile>("wrangler.dedicated-cloud.jsonc");
    expectCommonTenantContract(config, "dedicated_cloud");
    expect(config.name).toBe("mana-runtime-dedicated-reference");
    expect(config.queues.producers[0]?.queue).toBe("mana-runtime-dedicated-reference-events");
    expect(config.queues.consumers[0]?.dead_letter_queue)
      .toBe("mana-runtime-dedicated-reference-events-dlq");
  });

  it("customer_managed_ossを資格情報なしの顧客管理manifestからbuildする", () => {
    const config = loadJson<WranglerProfile>("wrangler.customer-managed-oss.jsonc");
    const manifest = loadJson<CustomerManagedDeploymentManifest>(
      "deployments/customer-managed-oss/manifest.json",
    );

    expectCommonTenantContract(config, "customer_managed_oss");
    expect(config.account_id).toBeUndefined();
    expect(manifest).toMatchObject({
      schema_version: "1.0",
      deployment_profile: "customer_managed_oss",
      runtime: {
        target: "cloudflare-workers-compatible",
        config: "wrangler.customer-managed-oss.jsonc",
        output: "dist/customer-managed-oss",
      },
      contract: { protocol_id: "mana-brainbase-tenant-context" },
      credential_modes: ["customer_oauth", "customer_api"],
      secrets: { values_included: false },
    });
    expect(manifest.contract.required_capabilities).toEqual(
      expect.arrayContaining(REQUIRED_CAPABILITIES),
    );
    expect(manifest.required_bindings).toEqual({
      services: [
        "BRAINBASE_TENANT_RUNTIME_SERVICE",
        "SLACK_INSTALLATION_CONTROL_PLANE",
      ],
      durable_objects: [{
        binding: "TENANT_RUNTIME_STATE",
        class_name: "TenantRuntimeState",
        migration_required: true,
      }],
    });
    expect(manifest.oauth).toEqual({
      required_vars: [
        "SLACK_OAUTH_APP_ID",
        "SLACK_OAUTH_CLIENT_ID",
        "SLACK_OAUTH_REDIRECT_URI",
        "SLACK_OAUTH_SCOPES",
      ],
      state: {
        durable_object_binding: "TENANT_RUNTIME_STATE",
        durable_object_class: "TenantRuntimeState",
        migration_required: true,
      },
    });
    expect(manifest.secrets.required_names).toEqual(expect.arrayContaining([
      "SLACK_SIGNING_SECRET",
      "BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN",
      "SLACK_INSTALLATION_LIFECYCLE_TOKEN",
    ]));
    const source = [JSON.stringify(config), JSON.stringify(manifest)].join("\n");
    expect(source).not.toMatch(/(?:token|secret)\s*["']?\s*[:=]\s*["'][^"']{8,}/i);
  });

  it("unson-businessは本番Brainbaseの公開検証鍵だけを直接JWK形式で固定する", () => {
    const config = loadJson<WranglerProfile>("wrangler.unson-business.jsonc");
    const jwks = JSON.parse(config.vars.BRAINBASE_TENANT_CONTEXT_JWKS_JSON) as {
      keys: Array<Record<string, string>>;
    };

    expect(jwks).toEqual({
      keys: [{
        kid: "brainbase-tenant-context-20260819",
        kty: "OKP",
        crv: "Ed25519",
        x: "eWbEUe--SU-Z0010NfiLcbAMIC3Q57h_Q9oJV9CekoQ",
        use: "sig",
        alg: "EdDSA",
      }],
    });
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });

  it("通常Queue consumerはmax_retries=3とDLQを持ち、DLQ consumerも再試行上限を持つ", () => {
    const configs = [
      loadJson<WranglerProfile>("wrangler.jsonc"),
      loadJson<WranglerProfile>("wrangler.unson-business.jsonc"),
      loadJson<WranglerProfile>("wrangler.dedicated-cloud.jsonc"),
      loadJson<WranglerProfile>("wrangler.customer-managed-oss.jsonc"),
    ];
    for (const config of configs) {
      for (const consumer of config.queues.consumers) {
        expect(Number.isSafeInteger(consumer.max_retries)).toBe(true);
        expect(consumer.max_retries).toBe(3);
        if (!consumer.queue.endsWith("-dlq")) {
          expect(consumer.dead_letter_queue).toMatch(/-dlq$/);
        }
      }
    }
  });

  it("実profileはcontrol-plane bindingを持ち、未設定のOAuth公開値を明示する", () => {
    const configs = [
      loadJson<WranglerProfile>("wrangler.jsonc"),
      loadJson<WranglerProfile>("wrangler.unson-business.jsonc"),
      loadJson<WranglerProfile>("wrangler.dedicated-cloud.jsonc"),
      loadJson<WranglerProfile>("wrangler.customer-managed-oss.jsonc"),
    ];
    for (const config of configs) {
      const readiness = assessTenantRuntimeDeploymentConfig(config, []);
      expect(readiness.ready).toBe(false);
      expect(readiness.missing_bindings).not.toContain(
        "SLACK_INSTALLATION_CONTROL_PLANE",
      );
      const oauthBindings = [
        "SLACK_OAUTH_APP_ID", "SLACK_OAUTH_CLIENT_ID", "SLACK_OAUTH_REDIRECT_URI", "SLACK_OAUTH_SCOPES",
      ];
      if (config.name === "unson-business-mana-runtime") {
        expect(readiness.missing_bindings).not.toEqual(expect.arrayContaining(oauthBindings));
      } else {
        expect(readiness.missing_bindings).toEqual(expect.arrayContaining(oauthBindings));
      }
    }
  });
});
