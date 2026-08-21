import { REQUIRED_TENANT_CAPABILITIES } from "./contracts.js";

export interface TenantRuntimeReadiness {
  ready: boolean;
  missing_bindings: string[];
}

const REQUIRED_TEXT_BINDINGS = [
  "MANA_REQUIRED_AUDIENCE",
  "MANA_REQUIRED_PROJECT_ID",
  "MANA_REQUIRED_CAPABILITY_ID",
  "MANA_CREDENTIAL_AUDIENCE",
  "SLACK_SIGNING_SECRET",
  "SLACK_INSTALLATION_LIFECYCLE_TOKEN",
  "SLACK_EXPECTED_APP_ID",
  "SLACK_OAUTH_APP_ID",
  "SLACK_OAUTH_CLIENT_ID",
  "SLACK_OAUTH_REDIRECT_URI",
  "SLACK_OAUTH_SCOPES",
  "BRAINBASE_TENANT_RUNTIME_ENABLED",
  "BRAINBASE_TENANT_RUNTIME_PORT",
] as const;

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function safeHttpsUrl(value: unknown): boolean {
  if (!nonEmpty(value)) return false;
  try {
    const url = new URL(value as string);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validSlackOAuthAppId(value: unknown): boolean {
  return nonEmpty(value) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value as string);
}

function validSlackOAuthClientId(value: unknown): boolean {
  return nonEmpty(value) && /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(value as string);
}

function validSlackOAuthScopes(value: unknown): boolean {
  if (!nonEmpty(value)) return false;
  const scopes = (value as string).split(",").map((scope) => scope.trim()).filter(Boolean);
  return scopes.length > 0
    && scopes.every((scope) => /^[a-z][a-z0-9_.:-]{0,127}$/.test(scope));
}

function validJwks(value: unknown): boolean {
  if (!nonEmpty(value)) return false;
  try {
    const parsed = JSON.parse(value as string) as { keys?: unknown };
    return Array.isArray(parsed.keys) && parsed.keys.some((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const key = candidate as Record<string, unknown>;
      return key.kty === "OKP" && key.crv === "Ed25519"
        && nonEmpty(key.kid) && nonEmpty(key.x)
        && key.d === undefined
        && (key.use === undefined || key.use === "sig");
    });
  } catch {
    return false;
  }
}

function placementTaskBoardEnabled(value: unknown): boolean {
  if (!nonEmpty(value)) return false;
  try {
    const placements = JSON.parse(value as string) as unknown;
    return Array.isArray(placements) && placements.some((placement) =>
      placement !== null && typeof placement === "object"
      && !Array.isArray(placement)
      && (placement as Record<string, unknown>).taskBoardEnabled === true);
  } catch {
    return false;
  }
}

function placementDevelopmentEnabled(value: unknown): boolean {
  if (!nonEmpty(value)) return false;
  try {
    const placements = JSON.parse(value as string) as unknown;
    return Array.isArray(placements) && placements.some((placement) =>
      placement !== null && typeof placement === "object"
      && !Array.isArray(placement)
      && (placement as Record<string, unknown>).developmentEnabled === true);
  } catch {
    return false;
  }
}

export function assessTenantRuntimeReadiness(
  env: Record<string, unknown>,
): TenantRuntimeReadiness {
  const missing: string[] = [];
  const profile = env.MANA_DEPLOYMENT_PROFILE;
  if (profile !== "shared_cloud" && profile !== "dedicated_cloud" && profile !== "customer_managed_oss") {
    missing.push("MANA_DEPLOYMENT_PROFILE");
  }
  for (const binding of REQUIRED_TEXT_BINDINGS) {
    if (!nonEmpty(env[binding])) missing.push(binding);
  }
  if (!validSlackOAuthAppId(env.SLACK_OAUTH_APP_ID)
    || (nonEmpty(env.SLACK_EXPECTED_APP_ID) && env.SLACK_OAUTH_APP_ID !== env.SLACK_EXPECTED_APP_ID)) {
    if (!missing.includes("SLACK_OAUTH_APP_ID")) missing.push("SLACK_OAUTH_APP_ID");
  }
  if (!validSlackOAuthClientId(env.SLACK_OAUTH_CLIENT_ID)
    && !missing.includes("SLACK_OAUTH_CLIENT_ID")) {
    missing.push("SLACK_OAUTH_CLIENT_ID");
  }
  if (!safeHttpsUrl(env.SLACK_OAUTH_REDIRECT_URI)
    && !missing.includes("SLACK_OAUTH_REDIRECT_URI")) {
    missing.push("SLACK_OAUTH_REDIRECT_URI");
  }
  if (!validSlackOAuthScopes(env.SLACK_OAUTH_SCOPES)
    && !missing.includes("SLACK_OAUTH_SCOPES")) {
    missing.push("SLACK_OAUTH_SCOPES");
  }
  if (env.BRAINBASE_TENANT_RUNTIME_ENABLED !== "1"
    && !missing.includes("BRAINBASE_TENANT_RUNTIME_ENABLED")) {
    missing.push("BRAINBASE_TENANT_RUNTIME_ENABLED");
  }
  const trustedForwardHost = nonEmpty(env.BRAINBASE_TENANT_RUNTIME_HOST)
    ? String(env.BRAINBASE_TENANT_RUNTIME_HOST).trim()
    : "127.0.0.1";
  if (["0.0.0.0", "::", "[::]", "*"].includes(trustedForwardHost)
    || (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(trustedForwardHost)
      && env.BRAINBASE_TENANT_RUNTIME_ALLOW_NON_LOOPBACK !== "1")) {
    missing.push("BRAINBASE_TENANT_RUNTIME_HOST");
  }
  const trustedForwardPort = Number(env.BRAINBASE_TENANT_RUNTIME_PORT);
  if (!Number.isInteger(trustedForwardPort) || trustedForwardPort < 1 || trustedForwardPort > 65_535) {
    if (!missing.includes("BRAINBASE_TENANT_RUNTIME_PORT")) missing.push("BRAINBASE_TENANT_RUNTIME_PORT");
  }
  const trustedService = env.BRAINBASE_TENANT_RUNTIME_SERVICE as { fetch?: unknown } | undefined;
  if (!trustedService || typeof trustedService.fetch !== "function") {
    missing.push("BRAINBASE_TENANT_RUNTIME_SERVICE");
  }
  const slackControlPlane = env.SLACK_INSTALLATION_CONTROL_PLANE as { fetch?: unknown } | undefined;
  if (!slackControlPlane || typeof slackControlPlane.fetch !== "function") {
    missing.push("SLACK_INSTALLATION_CONTROL_PLANE");
  }
  const scopes = typeof env.MANA_REQUIRED_SLACK_SCOPES === "string"
    ? env.MANA_REQUIRED_SLACK_SCOPES.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  if (scopes.length === 0) missing.push("MANA_REQUIRED_SLACK_SCOPES");
  const taskBoardSchedulingEnabled = env.RUNTIME_TASK_BOARD_ENABLED === "true"
    || placementTaskBoardEnabled(env.RUNTIME_PLACEMENTS_JSON);
  if (taskBoardSchedulingEnabled && !nonEmpty(env.TASK_BOARD_TARGETS_JSON)) {
    missing.push("TASK_BOARD_TARGETS_JSON");
  }
  if ((taskBoardSchedulingEnabled || nonEmpty(env.TASK_BOARD_TARGETS_JSON))
    && !nonEmpty(env.MANA_TASK_BOARD_SERVICE_ACTOR_ID)) {
    missing.push("MANA_TASK_BOARD_SERVICE_ACTOR_ID");
  }
  if (placementDevelopmentEnabled(env.RUNTIME_PLACEMENTS_JSON)) {
    if (!safeHttpsUrl(env.DEVELOPMENT_CALLBACK_BASE_URL)) missing.push("DEVELOPMENT_CALLBACK_BASE_URL");
    if (!nonEmpty(env.DEVELOPMENT_CALLBACK_TOKEN)) missing.push("DEVELOPMENT_CALLBACK_TOKEN");
  }
  const capabilities = new Set(typeof env.MANA_RUNTIME_CAPABILITIES === "string"
    ? env.MANA_RUNTIME_CAPABILITIES.split(",").map((value) => value.trim()).filter(Boolean)
    : []);
  if (REQUIRED_TENANT_CAPABILITIES.some((capability) => !capabilities.has(capability))) {
    missing.push("MANA_RUNTIME_CAPABILITIES");
  }
  if (!validJwks(env.BRAINBASE_TENANT_CONTEXT_JWKS_JSON)) {
    missing.push("BRAINBASE_TENANT_CONTEXT_JWKS_JSON");
  }
  if (!env.TENANT_RUNTIME_STATE) missing.push("TENANT_RUNTIME_STATE");
  return { ready: missing.length === 0, missing_bindings: missing.sort() };
}
