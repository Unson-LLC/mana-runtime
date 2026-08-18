import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
  queues: {
    producers: Array<{ queue: string }>;
    consumers: Array<{ queue: string; dead_letter_queue: string }>;
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
  expect(config.durable_objects.bindings).toContainEqual({
    name: "TENANT_RUNTIME_STATE",
    class_name: "TenantRuntimeState",
  });
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
    const manifest = loadJson<{
      schema_version: string;
      deployment_profile: string;
      runtime: { target: string; config: string; output: string };
      contract: { protocol_id: string; required_capabilities: string[] };
      credential_modes: string[];
      secrets: { required_names: string[]; values_included: boolean };
    }>("deployments/customer-managed-oss/manifest.json");

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
    expect(manifest.secrets.required_names).toEqual(expect.arrayContaining([
      "SLACK_SIGNING_SECRET",
      "BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN",
    ]));
    const source = [JSON.stringify(config), JSON.stringify(manifest)].join("\n");
    expect(source).not.toMatch(/(?:token|secret)\s*["']?\s*[:=]\s*["'][^"']{8,}/i);
  });
});
