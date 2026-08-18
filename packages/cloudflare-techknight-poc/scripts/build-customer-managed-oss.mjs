import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const packageRoot = new URL("..", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL(
  "deployments/customer-managed-oss/manifest.json",
  packageRoot,
), "utf8"));
const config = JSON.parse(readFileSync(new URL(manifest.runtime.config, packageRoot), "utf8"));
const requiredCapabilities = [
  "signed_tenant_context",
  "connection_revision_recheck",
  "tenant_scoped_authorization",
  "credential_broker_v1",
  "usage_receipt_v1",
  "idempotent_effects_v1",
  "container_sanitization_v1",
];

function fail(message) {
  throw new Error(`customer-managed OSS manifest invalid: ${message}`);
}

if (manifest.schema_version !== "1.0") fail("schema_version");
if (manifest.deployment_profile !== "customer_managed_oss") fail("deployment_profile");
if (manifest.runtime.target !== "cloudflare-workers-compatible") fail("runtime.target");
if (manifest.runtime.entrypoint !== config.main) fail("runtime.entrypoint");
if (config.vars?.MANA_DEPLOYMENT_PROFILE !== manifest.deployment_profile) fail("config profile");
if (Object.hasOwn(config, "account_id")) fail("account_id must remain customer-owned");
if (manifest.secrets?.values_included !== false) fail("secret values must not be distributed");
if (!Array.isArray(manifest.secrets?.required_names) || manifest.secrets.required_names.length === 0) {
  fail("secret names");
}
const manifestCapabilities = new Set(manifest.contract?.required_capabilities ?? []);
const configCapabilities = new Set(String(config.vars?.MANA_RUNTIME_CAPABILITIES ?? "").split(","));
for (const capability of requiredCapabilities) {
  if (!manifestCapabilities.has(capability) || !configCapabilities.has(capability)) {
    fail(`required capability ${capability}`);
  }
}
if (JSON.stringify(manifest).includes("cloud_standard")) fail("cloud_standard credential fallback");

const result = spawnSync("wrangler", [
  "deploy",
  "--config",
  manifest.runtime.config,
  "--dry-run",
  "--outdir",
  manifest.runtime.output,
], {
  cwd: packageRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
