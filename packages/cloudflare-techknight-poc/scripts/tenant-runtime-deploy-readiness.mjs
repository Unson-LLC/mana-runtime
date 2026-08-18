import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REQUIRED_TEXT_VARS = [
  "TENANT_ID",
  "SLACK_EXPECTED_APP_ID",
  "MANA_REQUIRED_AUDIENCE",
  "MANA_REQUIRED_PROJECT_ID",
  "MANA_REQUIRED_CAPABILITY_ID",
  "MANA_CREDENTIAL_AUDIENCE",
  "BRAINBASE_TENANT_RUNTIME_ENABLED",
  "BRAINBASE_TENANT_RUNTIME_PORT",
];

const REQUIRED_HTTPS_VARS = [
  "BRAINBASE_TENANT_AUTHORITY_URL",
  "BRAINBASE_CREDENTIAL_BROKER_URL",
  "BRAINBASE_QUOTA_URL",
  "BRAINBASE_ACCOUNTING_URL",
];

const REQUIRED_CAPABILITIES = [
  "signed_tenant_context",
  "connection_revision_recheck",
  "tenant_scoped_authorization",
  "credential_broker_v1",
  "usage_receipt_v1",
  "idempotent_effects_v1",
  "container_sanitization_v1",
];

const REQUIRED_SECRET_BINDINGS = [
  "BRAINBASE_RUNTIME_API_TOKEN",
  "BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_INSTALLATION_LIFECYCLE_TOKEN",
];

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeHttpsUrl(value) {
  if (!nonEmpty(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validJwks(value) {
  if (!nonEmpty(value)) return false;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed?.keys) && parsed.keys.some((candidate) =>
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
      && candidate.kty === "OKP" && candidate.crv === "Ed25519"
      && nonEmpty(candidate.kid) && nonEmpty(candidate.x)
      && (candidate.use === undefined || candidate.use === "sig"));
  } catch {
    return false;
  }
}

function parsePlacements(value) {
  if (!nonEmpty(value)) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasNamedBinding(bindings, name, valueKey) {
  return Array.isArray(bindings) && bindings.some((binding) =>
    binding && typeof binding === "object"
    && binding.name === name
    && nonEmpty(binding[valueKey]));
}

function hasServiceBinding(bindings, name) {
  return Array.isArray(bindings) && bindings.some((binding) =>
    binding && typeof binding === "object"
    && binding.binding === name
    && nonEmpty(binding.service));
}

export function assessTenantRuntimeDeploymentConfig(config, secretNames) {
  const vars = config?.vars && typeof config.vars === "object" ? config.vars : {};
  const secrets = new Set(secretNames);
  const missing = new Set();

  if (!["shared_cloud", "dedicated_cloud", "customer_managed_oss"].includes(vars.MANA_DEPLOYMENT_PROFILE)) {
    missing.add("MANA_DEPLOYMENT_PROFILE");
  }
  for (const name of REQUIRED_TEXT_VARS) {
    if (!nonEmpty(vars[name])) missing.add(name);
  }
  if (vars.BRAINBASE_TENANT_RUNTIME_ENABLED !== "1") {
    missing.add("BRAINBASE_TENANT_RUNTIME_ENABLED");
  }
  const trustedHost = nonEmpty(vars.BRAINBASE_TENANT_RUNTIME_HOST)
    ? vars.BRAINBASE_TENANT_RUNTIME_HOST.trim()
    : "127.0.0.1";
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (["0.0.0.0", "::", "[::]", "*"].includes(trustedHost)
    || (!loopbackHosts.has(trustedHost) && vars.BRAINBASE_TENANT_RUNTIME_ALLOW_NON_LOOPBACK !== "1")) {
    missing.add("BRAINBASE_TENANT_RUNTIME_HOST");
  }
  const trustedPort = Number(vars.BRAINBASE_TENANT_RUNTIME_PORT);
  if (!Number.isInteger(trustedPort) || trustedPort < 1 || trustedPort > 65_535) {
    missing.add("BRAINBASE_TENANT_RUNTIME_PORT");
  }
  if (!nonEmpty(vars.MANA_REQUIRED_SLACK_SCOPES)
    || vars.MANA_REQUIRED_SLACK_SCOPES.split(",").every((scope) => !scope.trim())) {
    missing.add("MANA_REQUIRED_SLACK_SCOPES");
  }
  const capabilities = new Set(nonEmpty(vars.MANA_RUNTIME_CAPABILITIES)
    ? vars.MANA_RUNTIME_CAPABILITIES.split(",").map((value) => value.trim()).filter(Boolean)
    : []);
  if (REQUIRED_CAPABILITIES.some((capability) => !capabilities.has(capability))) {
    missing.add("MANA_RUNTIME_CAPABILITIES");
  }
  for (const name of REQUIRED_HTTPS_VARS) {
    if (!safeHttpsUrl(vars[name])) missing.add(name);
  }
  if (!validJwks(vars.BRAINBASE_TENANT_CONTEXT_JWKS_JSON)) {
    missing.add("BRAINBASE_TENANT_CONTEXT_JWKS_JSON");
  }
  if (!hasServiceBinding(config?.services, "BRAINBASE_TENANT_RUNTIME_SERVICE")) {
    missing.add("BRAINBASE_TENANT_RUNTIME_SERVICE");
  }
  if (!hasNamedBinding(config?.durable_objects?.bindings, "TENANT_RUNTIME_STATE", "class_name")) {
    missing.add("TENANT_RUNTIME_STATE");
  }
  const placements = parsePlacements(vars.RUNTIME_PLACEMENTS_JSON);
  const taskBoardEnabled = vars.RUNTIME_TASK_BOARD_ENABLED === "true"
    || placements.some((placement) => placement?.taskBoardEnabled === true);
  if (taskBoardEnabled && !nonEmpty(vars.TASK_BOARD_TARGETS_JSON)) missing.add("TASK_BOARD_TARGETS_JSON");
  if ((taskBoardEnabled || nonEmpty(vars.TASK_BOARD_TARGETS_JSON))
    && !nonEmpty(vars.MANA_TASK_BOARD_SERVICE_ACTOR_ID)) {
    missing.add("MANA_TASK_BOARD_SERVICE_ACTOR_ID");
  }
  const developmentEnabled = placements.some((placement) => placement?.developmentEnabled === true);
  if (developmentEnabled) {
    if (!safeHttpsUrl(vars.DEVELOPMENT_CALLBACK_BASE_URL)) missing.add("DEVELOPMENT_CALLBACK_BASE_URL");
    if (!secrets.has("DEVELOPMENT_CALLBACK_TOKEN")) missing.add("DEVELOPMENT_CALLBACK_TOKEN");
  }
  for (const name of REQUIRED_SECRET_BINDINGS) {
    if (!secrets.has(name)) missing.add(name);
  }

  const missingBindings = [...missing].sort();
  return { ready: missingBindings.length === 0, missing_bindings: missingBindings };
}

export function parseWranglerSecretNames(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("tenant_runtime_secret_list_invalid");
  }
  if (!Array.isArray(parsed)) throw new Error("tenant_runtime_secret_list_invalid");
  const names = parsed.map((entry) => entry?.name).filter(nonEmpty);
  if (names.length !== parsed.length) throw new Error("tenant_runtime_secret_list_invalid");
  return [...new Set(names)].sort();
}

export function assertTenantRuntimeDeploymentConfig(config, secretNames) {
  const result = assessTenantRuntimeDeploymentConfig(config, secretNames);
  if (!result.ready) {
    throw new Error(`tenant_runtime_deploy_preflight_failed:${result.missing_bindings.join(",")}`);
  }
  return result;
}

export async function assertTenantRuntimeDeploymentPreflight({ configPath, execFileImpl = execFileAsync }) {
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error("tenant_runtime_deploy_config_invalid");
  }

  // Static configuration must be complete before consulting Cloudflare. This keeps
  // local validation deterministic and avoids unnecessary remote calls.
  assertTenantRuntimeDeploymentConfig(config, [
    ...REQUIRED_SECRET_BINDINGS,
    "DEVELOPMENT_CALLBACK_TOKEN",
  ]);

  let stdout;
  try {
    ({ stdout } = await execFileImpl("pnpm", [
      "exec", "wrangler", "secret", "list", "--config", configPath, "--format", "json",
    ], {
      cwd: dirname(configPath),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }));
  } catch {
    throw new Error("tenant_runtime_secret_list_unavailable");
  }
  assertTenantRuntimeDeploymentConfig(config, parseWranglerSecretNames(stdout));
  return { config, tenantId: config.vars.TENANT_ID };
}

export async function assertTenantRuntimeHealthReady({
  baseUrl,
  expectedTenantId,
  fetchImpl = fetch,
  timeoutMs = 10_000,
}) {
  if (!safeHttpsUrl(baseUrl) || !nonEmpty(expectedTenantId)) {
    throw new Error("tenant_runtime_post_deploy_config_invalid");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(new URL("/health", baseUrl), {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new Error("tenant_runtime_post_deploy_unreachable");
  } finally {
    clearTimeout(timeout);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("tenant_runtime_post_deploy_response_invalid");
  }
  const missing = Array.isArray(body?.tenant_runtime?.missing_bindings)
    ? body.tenant_runtime.missing_bindings.filter(nonEmpty).sort()
    : [];
  if (!response.ok || body?.ok !== true || body?.tenant_runtime?.ready !== true) {
    throw new Error(`tenant_runtime_post_deploy_not_ready:${missing.length > 0 ? missing.join(",") : "unknown"}`);
  }
  if (body.tenant !== expectedTenantId || missing.length !== 0) {
    throw new Error("tenant_runtime_post_deploy_tenant_mismatch");
  }
  return body;
}
