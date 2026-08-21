import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_SOURCE_LOCK_PATHS = Object.freeze({
  tenantContext: fileURLToPath(new URL(
    "../../../contracts/mana-brainbase-tenant-context/v1/source-lock.json",
    import.meta.url,
  )),
  trustedProviderForwarder: fileURLToPath(new URL(
    "../../../contracts/brainbase-trusted-provider-forwarder/v1/source-lock.json",
    import.meta.url,
  )),
});

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DEPLOYMENT_AUTH_TEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+,-]{0,255}$/;
const DEPLOYMENT_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const AUTHORIZATION_ONLY_COMMIT_PATHS = Object.freeze([
  "contracts/brainbase-trusted-provider-forwarder/v1/source-lock.json",
  "contracts/mana-brainbase-tenant-context/v1/source-lock.json",
]);

const REQUIRED_TEXT_VARS = [
  "TENANT_ID",
  "SLACK_EXPECTED_APP_ID",
  "SLACK_OAUTH_APP_ID",
  "SLACK_OAUTH_CLIENT_ID",
  "SLACK_OAUTH_REDIRECT_URI",
  "SLACK_OAUTH_SCOPES",
  "MANA_REQUIRED_AUDIENCE",
  "MANA_REQUIRED_CAPABILITY_ID",
  "MANA_CREDENTIAL_AUDIENCE",
  "BRAINBASE_TENANT_RUNTIME_ENABLED",
  "BRAINBASE_TENANT_RUNTIME_PORT",
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
  "SLACK_SIGNING_SECRET",
  "SLACK_INSTALLATION_LIFECYCLE_TOKEN",
];

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function exactStringArray(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function sourceLockError(lockId, reason) {
  return new Error(`tenant_runtime_source_lock_preflight_failed:${lockId}:${reason}`);
}

function deploymentAuthorizationError(lockId, reason) {
  return sourceLockError(lockId, `deployment_authorization_${reason}`);
}

export function assertTenantRuntimeAuthorizationOnlyChild({
  reviewedCommit,
  candidateCommit,
  candidateParentCommits,
  changedEntries,
} = {}) {
  if (!GIT_SHA_PATTERN.test(reviewedCommit)
    || !GIT_SHA_PATTERN.test(candidateCommit)
    || candidateCommit === reviewedCommit
    || !Array.isArray(candidateParentCommits)
    || candidateParentCommits.length !== 1
    || candidateParentCommits[0] !== reviewedCommit) {
    throw new Error("tenant_runtime_deploy_authorization_parent_invalid");
  }

  const expected = AUTHORIZATION_ONLY_COMMIT_PATHS.map((path) => `M\t${path}`).sort();
  const actual = Array.isArray(changedEntries)
    && changedEntries.every((entry) => typeof entry === "string")
    ? [...changedEntries].sort()
    : null;
  if (actual === null || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("tenant_runtime_deploy_authorization_commit_invalid");
  }

  return { reviewedCommit, candidateCommit };
}

async function readSourceLock(readFileImpl, path, lockId) {
  let serialized;
  try {
    serialized = await readFileImpl(path, "utf8");
  } catch {
    throw sourceLockError(lockId, "missing");
  }
  try {
    const parsed = JSON.parse(String(serialized));
    if (!plainObject(parsed)) throw new Error("invalid");
    return parsed;
  } catch {
    throw sourceLockError(lockId, "invalid");
  }
}

function validAuditInput(value, expectedRepository) {
  return plainObject(value)
    && value.repository === expectedRepository
    && positiveInteger(value.pull_request)
    && GIT_SHA_PATTERN.test(value.head);
}

function validDeploymentAuthorizationText(value) {
  return typeof value === "string"
    && DEPLOYMENT_AUTH_TEXT_PATTERN.test(value)
    && value.trim() === value;
}

function validDeploymentTimestamp(value) {
  if (typeof value !== "string" || !DEPLOYMENT_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function deploymentContextTimestamp(value) {
  if (value === undefined) return Date.now();
  if (value instanceof Date) return value.getTime();
  if (!validDeploymentTimestamp(value)) return null;
  return Date.parse(value);
}

function validateDeploymentAuthorization(lock, lockId, {
  deploymentTarget,
  candidateCommit,
  reviewedCommit,
  now,
} = {}) {
  const authorization = lock.deployment_authorization;
  if (!lock.deploy_allowed) {
    // A disabled lock cannot carry an active authorization. Keeping the field
    // null (or omitting it) makes accidental reuse observable and fail closed.
    if (authorization !== undefined && authorization !== null) {
      throw deploymentAuthorizationError(lockId, "invalid");
    }
    return;
  }

  if (!plainObject(authorization)) {
    throw deploymentAuthorizationError(lockId, "missing");
  }
  if (!validDeploymentAuthorizationText(authorization.reviewer_identity)
    || !validDeploymentAuthorizationText(authorization.reviewer_provenance)
    || !GIT_SHA_PATTERN.test(authorization.reviewed_commit_sha)
    || !validDeploymentAuthorizationText(authorization.target)
    || !validDeploymentTimestamp(authorization.authorized_at)
    || !validDeploymentTimestamp(authorization.expires_at)) {
    throw deploymentAuthorizationError(lockId, "invalid");
  }

  const nowMs = deploymentContextTimestamp(now);
  if (nowMs === null) throw deploymentAuthorizationError(lockId, "context_invalid");
  const authorizedAtMs = Date.parse(authorization.authorized_at);
  const expiresAtMs = Date.parse(authorization.expires_at);
  if (authorizedAtMs > nowMs || expiresAtMs <= authorizedAtMs) {
    throw deploymentAuthorizationError(lockId, "invalid");
  }
  if (expiresAtMs <= nowMs) {
    throw deploymentAuthorizationError(lockId, "expired");
  }
  if (!validDeploymentAuthorizationText(deploymentTarget)
    || !GIT_SHA_PATTERN.test(candidateCommit)
    || !GIT_SHA_PATTERN.test(reviewedCommit)) {
    throw deploymentAuthorizationError(lockId, "context_missing");
  }
  if (authorization.target !== deploymentTarget) {
    throw deploymentAuthorizationError(lockId, "target_mismatch");
  }
  if (authorization.reviewed_commit_sha !== reviewedCommit) {
    throw deploymentAuthorizationError(lockId, "candidate_mismatch");
  }
}

function validateTenantContextSourceLock(lock) {
  const valid = lock.schema_version === "1.0"
    && lock.kit_role === "canonical_conformance_contract"
    && plainObject(lock.cross_contract)
    && lock.cross_contract.repository === "Unson-LLC/mana-runtime"
    && positiveInteger(lock.cross_contract.pull_request)
    && GIT_SHA_PATTERN.test(lock.cross_contract.input_head)
    && validAuditInput(lock.producer_audit_input, "Unson-LLC/brainbase-unson")
    && validAuditInput(lock.consumer_audit_input, "Unson-LLC/mana-runtime")
    && SHA256_PATTERN.test(lock.fixture_set_sha256)
    && typeof lock.production_code_changed === "boolean"
    && typeof lock.merge_allowed === "boolean"
    && typeof lock.deploy_allowed === "boolean";
  if (!valid) throw sourceLockError("tenant_context", "invalid");
  if (lock.cross_contract.input_head !== lock.consumer_audit_input.head) {
    throw sourceLockError("tenant_context", "stale");
  }
  return lock;
}

function validateTrustedProviderForwarderSourceLock(lock) {
  const producerFiles = lock.producer?.files;
  const validFiles = plainObject(producerFiles)
    && Object.keys(producerFiles).length > 0
    && Object.entries(producerFiles).every(([path, sha]) => nonEmpty(path) && SHA256_PATTERN.test(sha));
  const wire = lock.wire;
  const configuration = wire?.configuration;
  const headers = wire?.headers;
  const security = lock.security;
  const validWire = plainObject(wire)
    && wire.method === "POST"
    && wire.path === "/api/v1/runtime/provider-requests:forward"
    && wire.protocol_version === "1.0"
    && plainObject(configuration)
    && configuration.enabled_env === "BRAINBASE_TENANT_RUNTIME_ENABLED"
    && configuration.enabled_value === "1"
    && configuration.host_env === "BRAINBASE_TENANT_RUNTIME_HOST"
    && configuration.default_host === "127.0.0.1"
    && configuration.port_env === "BRAINBASE_TENANT_RUNTIME_PORT"
    && configuration.explicit_port_required === true
    && configuration.non_loopback_opt_in_env === "BRAINBASE_TENANT_RUNTIME_ALLOW_NON_LOOPBACK"
    && configuration.wildcard_bind_allowed_by_default === false
    && configuration.transport === "cloudflare_service_binding"
    && plainObject(headers)
    && headers.Authorization === undefined
    && headers["Brainbase-Protocol-Version"] === "1.0"
    && headers["Brainbase-Deployment-Id"] === "${tenant_context.placement.deployment_id}"
    && headers["Content-Type"] === "application/json"
    && wire.idempotency_key_pattern === "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$"
    && exactStringArray(wire.request_fields, [
      "tenant_context", "lease_id", "lease_token", "audience", "provider_operation", "request",
    ])
    && exactStringArray(wire.request_optional_fields, [
      "path_params", "query", "body", "target_url", "idempotency_key",
    ])
    && exactStringArray(wire.response_fields, [
      "provider", "operation_id", "provider_operation", "status", "response_encoding", "content_type", "body",
    ])
    && exactStringArray(wire.response_encoding_values, ["json", "utf8", "base64"])
    && exactStringArray(wire.canonical_error_codes, [
      "SCHEMA_INVALID",
      "SERVICE_AUTH_REQUIRED",
      "CREDENTIAL_LEASE_SCOPE_MISMATCH",
      "CREDENTIAL_LEASE_ALREADY_USED",
      "UPSTREAM_INVALID_RESPONSE",
      "UPSTREAM_UNAVAILABLE",
    ]);
  const validSecurity = plainObject(security)
    && security.raw_credential_returned_to_consumer === false
    && security.credential_reflection_rejected === true
    && security.provider_auth_headers_owned_by === "brainbase_trusted_service"
    && security.consumer_fallback_allowed === false;
  const valid = lock.schema_version === "1.0"
    && lock.contract_role === "brainbase_trusted_provider_forwarder_consumer"
    && plainObject(lock.producer)
    && lock.producer.repository === "Unson-LLC/brainbase-unson"
    && positiveInteger(lock.producer.pull_request)
    && GIT_SHA_PATTERN.test(lock.producer.head)
    && validFiles
    && plainObject(lock.tenant_context_contract)
    && lock.tenant_context_contract.repository === "Unson-LLC/mana-runtime"
    && positiveInteger(lock.tenant_context_contract.pull_request)
    && GIT_SHA_PATTERN.test(lock.tenant_context_contract.current_head)
    && SHA256_PATTERN.test(lock.tenant_context_contract.fixture_set_sha256)
    && validWire
    && validSecurity
    && typeof lock.merge_allowed === "boolean"
    && typeof lock.deploy_allowed === "boolean";
  if (!valid) throw sourceLockError("trusted_provider_forwarder", "invalid");
  return lock;
}

export async function assertTenantRuntimeSourceLocks({
  readFileImpl = readFile,
  sourceLockPaths = DEFAULT_SOURCE_LOCK_PATHS,
  deploymentTarget,
  candidateCommit,
  reviewedCommit = candidateCommit,
  now,
} = {}) {
  if (!nonEmpty(sourceLockPaths?.tenantContext)
    || !nonEmpty(sourceLockPaths?.trustedProviderForwarder)) {
    throw sourceLockError("canonical_paths", "invalid");
  }
  const [tenantContextInput, trustedProviderForwarderInput] = await Promise.all([
    readSourceLock(readFileImpl, sourceLockPaths.tenantContext, "tenant_context"),
    readSourceLock(readFileImpl, sourceLockPaths.trustedProviderForwarder, "trusted_provider_forwarder"),
  ]);
  const tenantContext = validateTenantContextSourceLock(tenantContextInput);
  const trustedProviderForwarder = validateTrustedProviderForwarderSourceLock(trustedProviderForwarderInput);
  if (trustedProviderForwarder.tenant_context_contract.current_head
      !== tenantContext.cross_contract.input_head
    || trustedProviderForwarder.tenant_context_contract.fixture_set_sha256
      !== tenantContext.fixture_set_sha256) {
    throw sourceLockError("cross_contract", "stale");
  }
  if (!tenantContext.deploy_allowed) {
    throw sourceLockError("tenant_context", "deploy_not_allowed");
  }
  if (!trustedProviderForwarder.deploy_allowed) {
    throw sourceLockError("trusted_provider_forwarder", "deploy_not_allowed");
  }
  validateDeploymentAuthorization(tenantContext, "tenant_context", {
    deploymentTarget,
    candidateCommit,
    reviewedCommit,
    now,
  });
  validateDeploymentAuthorization(trustedProviderForwarder, "trusted_provider_forwarder", {
    deploymentTarget,
    candidateCommit,
    reviewedCommit,
    now,
  });
  const tenantAuthorization = tenantContext.deployment_authorization;
  const forwarderAuthorization = trustedProviderForwarder.deployment_authorization;
  const authorizationFields = [
    "reviewer_identity",
    "reviewer_provenance",
    "reviewed_commit_sha",
    "target",
    "authorized_at",
    "expires_at",
  ];
  if (authorizationFields.some((field) => tenantAuthorization[field] !== forwarderAuthorization[field])) {
    throw new Error("tenant_runtime_source_lock_authorization_mismatch");
  }
  return { tenantContext, trustedProviderForwarder };
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

function validSlackOAuthAppId(value) {
  return nonEmpty(value) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function validSlackOAuthClientId(value) {
  return nonEmpty(value) && /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(value);
}

function validSlackOAuthScopes(value) {
  if (!nonEmpty(value)) return false;
  const scopes = value.split(",").map((scope) => scope.trim()).filter(Boolean);
  return scopes.length > 0
    && scopes.every((scope) => /^[a-z][a-z0-9_.:-]{0,127}$/.test(scope));
}

function validJwks(value) {
  if (!nonEmpty(value)) return false;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed?.keys) && parsed.keys.some((candidate) =>
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
      && candidate.kty === "OKP" && candidate.crv === "Ed25519"
      && nonEmpty(candidate.kid) && nonEmpty(candidate.x)
      && candidate.d === undefined
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

function validWorkspaceConnectionHints(value) {
  if (!nonEmpty(value)) return false;
  try {
    const hints = JSON.parse(value);
    return Array.isArray(hints) && hints.length > 0 && hints.every((hint) =>
      hint && typeof hint === "object" && !Array.isArray(hint)
      && [
        "tenant_id",
        "tenant_revision",
        "connection_id",
        "connection_revision",
        "workspace_id",
        "app_id",
      ].every((name) => nonEmpty(hint[name])));
  } catch {
    return false;
  }
}

function hasNamedBinding(bindings, name, valueKey) {
  return Array.isArray(bindings) && bindings.some((binding) =>
    binding && typeof binding === "object"
    && binding.name === name
    && nonEmpty(binding[valueKey]));
}

function hasServiceBinding(bindings, name, expectedService) {
  return Array.isArray(bindings) && bindings.some((binding) =>
    binding && typeof binding === "object"
    && binding.binding === name
    && binding.service === expectedService);
}

function hasDurableObjectMigration(migrations, className) {
  return Array.isArray(migrations) && migrations.some((migration) =>
    migration && typeof migration === "object"
    && Array.isArray(migration.new_sqlite_classes)
    && migration.new_sqlite_classes.includes(className));
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
  if (!validSlackOAuthAppId(vars.SLACK_OAUTH_APP_ID)
    || (nonEmpty(vars.SLACK_EXPECTED_APP_ID) && vars.SLACK_OAUTH_APP_ID !== vars.SLACK_EXPECTED_APP_ID)) {
    missing.add("SLACK_OAUTH_APP_ID");
  }
  if (!validSlackOAuthClientId(vars.SLACK_OAUTH_CLIENT_ID)) missing.add("SLACK_OAUTH_CLIENT_ID");
  if (!safeHttpsUrl(vars.SLACK_OAUTH_REDIRECT_URI)) missing.add("SLACK_OAUTH_REDIRECT_URI");
  if (!validSlackOAuthScopes(vars.SLACK_OAUTH_SCOPES)) missing.add("SLACK_OAUTH_SCOPES");
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
  const requiredSlackScopes = new Set(nonEmpty(vars.MANA_REQUIRED_SLACK_SCOPES)
    ? vars.MANA_REQUIRED_SLACK_SCOPES.split(",").map((scope) => scope.trim()).filter(Boolean)
    : []);
  const oauthSlackScopes = new Set(nonEmpty(vars.SLACK_OAUTH_SCOPES)
    ? vars.SLACK_OAUTH_SCOPES.split(",").map((scope) => scope.trim()).filter(Boolean)
    : []);
  if (requiredSlackScopes.size === 0
    || [...requiredSlackScopes].some((scope) => !oauthSlackScopes.has(scope))) {
    missing.add("MANA_REQUIRED_SLACK_SCOPES");
  }
  const capabilities = new Set(nonEmpty(vars.MANA_RUNTIME_CAPABILITIES)
    ? vars.MANA_RUNTIME_CAPABILITIES.split(",").map((value) => value.trim()).filter(Boolean)
    : []);
  if (REQUIRED_CAPABILITIES.some((capability) => !capabilities.has(capability))) {
    missing.add("MANA_RUNTIME_CAPABILITIES");
  }
  if (!validJwks(vars.BRAINBASE_TENANT_CONTEXT_JWKS_JSON)) {
    missing.add("BRAINBASE_TENANT_CONTEXT_JWKS_JSON");
  }
  const bootstrapMode = vars.MANA_BOOTSTRAP_MODE;
  if (bootstrapMode !== undefined && bootstrapMode !== "slack_oauth") {
    missing.add("MANA_BOOTSTRAP_MODE");
  }
  if (bootstrapMode !== "slack_oauth"
    && !validWorkspaceConnectionHints(vars.BRAINBASE_WORKSPACE_CONNECTIONS_JSON)) {
    missing.add("BRAINBASE_WORKSPACE_CONNECTIONS_JSON");
  }
  if (!hasServiceBinding(config?.services, "BRAINBASE_TENANT_RUNTIME_SERVICE", "brainbase-tenant-runtime")) {
    missing.add("BRAINBASE_TENANT_RUNTIME_SERVICE");
  }
  if (!hasServiceBinding(config?.services, "SLACK_INSTALLATION_CONTROL_PLANE", "brainbase-slack-installation-control-plane")) {
    missing.add("SLACK_INSTALLATION_CONTROL_PLANE");
  }
  const hasTenantRuntimeState = hasNamedBinding(
    config?.durable_objects?.bindings,
    "TENANT_RUNTIME_STATE",
    "class_name",
  );
  if (!hasTenantRuntimeState) {
    missing.add("TENANT_RUNTIME_STATE");
  }
  if (!hasDurableObjectMigration(config?.migrations, "TenantRuntimeState")) {
    missing.add("TENANT_RUNTIME_STATE_MIGRATION");
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

export async function assertTenantRuntimeDeploymentPreflight({
  configPath,
  execFileImpl = execFileAsync,
  readFileImpl = readFile,
  sourceLockPaths = DEFAULT_SOURCE_LOCK_PATHS,
  deploymentTarget,
  candidateCommit,
  reviewedCommit = candidateCommit,
  now,
}) {
  let config;
  try {
    config = JSON.parse(await readFileImpl(configPath, "utf8"));
  } catch {
    throw new Error("tenant_runtime_deploy_config_invalid");
  }

  // Static configuration must be complete before consulting Cloudflare. This keeps
  // local validation deterministic and avoids unnecessary remote calls.
  assertTenantRuntimeDeploymentConfig(config, [
    ...REQUIRED_SECRET_BINDINGS,
    "DEVELOPMENT_CALLBACK_TOKEN",
  ]);

  // These repository-owned locks are the canonical cross-system deployment
  // authorization. Validate them before any Cloudflare API or Wrangler access.
  await assertTenantRuntimeSourceLocks({
    readFileImpl,
    sourceLockPaths,
    deploymentTarget: deploymentTarget ?? config.name,
    candidateCommit,
    reviewedCommit,
    now,
  });

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
