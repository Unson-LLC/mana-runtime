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
const requiredOAuthVars = [
  "SLACK_OAUTH_APP_ID",
  "SLACK_OAUTH_CLIENT_ID",
  "SLACK_OAUTH_REDIRECT_URI",
  "SLACK_OAUTH_SCOPES",
];
const requiredServiceBindings = [
  "BRAINBASE_TENANT_RUNTIME_SERVICE",
  "SLACK_INSTALLATION_CONTROL_PLANE",
];
const requiredWorkerSecrets = [
  "SLACK_SIGNING_SECRET",
  "BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN",
  "BRAINBASE_RUNTIME_API_TOKEN",
  "SLACK_INSTALLATION_LIFECYCLE_TOKEN",
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
for (const secretName of requiredWorkerSecrets) {
  if (!manifest.secrets.required_names.includes(secretName)) fail(`required secret ${secretName}`);
}
if (!Array.isArray(manifest.required_bindings?.services)
  || JSON.stringify(manifest.required_bindings.services) !== JSON.stringify(requiredServiceBindings)) {
  fail("required service bindings");
}
if (!Array.isArray(manifest.required_bindings?.durable_objects)
  || manifest.required_bindings.durable_objects.length !== 1) {
  fail("required Durable Object bindings");
}
const [stateBinding] = manifest.required_bindings.durable_objects;
if (stateBinding?.binding !== "TENANT_RUNTIME_STATE"
  || stateBinding.class_name !== "TenantRuntimeState"
  || stateBinding.migration_required !== true) {
  fail("TenantRuntimeState binding/migration");
}
if (!Array.isArray(manifest.oauth?.required_vars)
  || JSON.stringify(manifest.oauth.required_vars) !== JSON.stringify(requiredOAuthVars)) {
  fail("OAuth required vars");
}
if (manifest.oauth.state?.durable_object_binding !== "TENANT_RUNTIME_STATE"
  || manifest.oauth.state?.durable_object_class !== "TenantRuntimeState"
  || manifest.oauth.state?.migration_required !== true) {
  fail("OAuth state Durable Object contract");
}
for (const variableName of requiredOAuthVars) {
  if (!manifest.required_customer_configuration?.includes(variableName)) {
    fail(`required customer configuration ${variableName}`);
  }
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
