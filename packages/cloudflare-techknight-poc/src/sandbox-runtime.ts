import { Sandbox as BaseSandbox, getSandbox } from "@cloudflare/sandbox";

import type { SandboxAdminEnv } from "./sandbox-admin.js";
import {
  createDurableTenantCredentialRegistry,
  forwardTenantCredentialRequest,
  type TenantCredentialRelayNamespace,
} from "./multitenancy/durable-credential-relay.js";
import {
  resolveDurableTenantBoundaryContext,
  TENANT_BOUNDARY_HANDLE_HEADER,
  type TenantBoundaryContextNamespace,
} from "./multitenancy/durable-tenant-boundary.js";
import {
  createTaskSearchProxyHandler,
  TASK_SEARCH_PROXY_HOST,
} from "./task-search-proxy.js";
import { createTaskWriteProxyHandler, TASK_WRITE_PROXY_HOST } from "./task-write-proxy.js";
import type { TaskBoardRepairEvent } from "./task-board.js";
import { handleNocodbProxyRequest, NOCODB_PROXY_HOST, type NocodbProxyEnv } from "./nocodb-proxy.js";
import { BRAINBASE_MCP_PROXY_HOST, handleBrainbaseMcpProxyRequest, type BrainbaseMcpProxyEnv } from "./brainbase-mcp-proxy.js";
import { GOOGLE_DRIVE_MCP_PROXY_HOST, handleGoogleDriveMcpProxyRequest, type GoogleDriveMcpProxyEnv } from "./google-drive-mcp-proxy.js";
import { createRuntimeGatewayProxyHandler, RUNTIME_GATEWAY_PROXY_HOST, type RuntimeGatewayProxyEnv } from "./runtime-gateway-proxy.js";
import { createTenantRuntimeHttpClients } from "./multitenancy/http-clients.js";
import { createTenantCredentialFetch } from "./multitenancy/tenant-credential-fetch.js";
import type { CredentialInjectionHeader } from "./multitenancy/credential-injector.js";
import type { DeploymentProfileName } from "./multitenancy/contracts.js";

export { ContainerProxy } from "@cloudflare/sandbox";

export interface SandboxRuntimeEnv extends SandboxAdminEnv, NocodbProxyEnv, BrainbaseMcpProxyEnv, GoogleDriveMcpProxyEnv, RuntimeGatewayProxyEnv {
  TECHKNIGHT_SANDBOX: DurableObjectNamespace<TechKnightSandbox>;
  RUNTIME_TASK_SEARCH_ENABLED?: string;
  RUNTIME_PROJECT_CODES?: string;
  BRAINBASE_TASK_API_BASE_URL?: string;
  BRAINBASE_TASK_API_TOKEN?: string;
  RUNTIME_TASK_WRITE_ENABLED?: string;
  TASK_WRITE_CAPABILITY_SECRET?: string;
  TASK_WRITE_POLICY_JSON?: string;
  RUNTIME_PLACEMENT_ID?: string;
  TENANT_ID?: string;
  TASK_BOARD_REPAIRS?: Queue<TaskBoardRepairEvent>;
  TASK_WRITE_BUDGETS?: DurableObjectNamespace;
  TASK_WRITE_APPROVALS?: DurableObjectNamespace;
  SLACK_BOT_TOKEN?: string;
  SLACK_EXPECTED_TEAM_ID?: string;
  SLACK_ALLOWED_CHANNEL_ID?: string;
  TASK_WRITE_APPROVAL_CHANNEL_ID?: string;
  DEVELOPMENT_CALLBACK_BASE_URL?: string;
  DEVELOPMENT_CALLBACK_TOKEN?: string;
  MANA_DEPLOYMENT_PROFILE?: string;
  BRAINBASE_TENANT_AUTHORITY_URL?: string;
  BRAINBASE_CREDENTIAL_BROKER_URL?: string;
  BRAINBASE_QUOTA_URL?: string;
  BRAINBASE_ACCOUNTING_URL?: string;
  BRAINBASE_RUNTIME_API_TOKEN?: string;
  BRAINBASE_RUNTIME_HTTP_TIMEOUT_MS?: string;
  BRAINBASE_TENANT_CONTEXT_JWKS_JSON?: string;
  TENANT_RUNTIME_STATE: TenantCredentialRelayNamespace & TenantBoundaryContextNamespace;
}

export const DEVELOPMENT_CALLBACK_PROXY_HOST = "development-callback.internal";

export class TechKnightSandbox extends BaseSandbox<SandboxRuntimeEnv> {
  interceptHttps = true;
  enableInternet = false;
  allowedHosts = ["api.anthropic.com", "github.com", DEVELOPMENT_CALLBACK_PROXY_HOST, TASK_SEARCH_PROXY_HOST, TASK_WRITE_PROXY_HOST, NOCODB_PROXY_HOST, BRAINBASE_MCP_PROXY_HOST, GOOGLE_DRIVE_MCP_PROXY_HOST, RUNTIME_GATEWAY_PROXY_HOST];
}

async function authorizeTenantRuntimeProxy(
  request: Request,
  env: SandboxRuntimeEnv,
  handler: (request: Request, credentialFetch: typeof fetch, proxyEnv: SandboxRuntimeEnv) => Promise<Response> | Response,
  credentialHeader?: CredentialInjectionHeader,
): Promise<Response> {
  const now = new Date().toISOString();
  const resolved = await resolveDurableTenantBoundaryContext(
    env.TENANT_RUNTIME_STATE,
    request,
    ["mcp_gateway", "brainbase_proxy"],
    now,
  );
  if (resolved instanceof Response) return resolved;
  let credentialFetch: typeof fetch;
  try {
    const clients = createTenantRuntimeHttpClients({
      deployment_profile: runtimeDeploymentProfile(env.MANA_DEPLOYMENT_PROFILE),
      tenant_authority_url: requiredProxyBinding(env.BRAINBASE_TENANT_AUTHORITY_URL),
      credential_broker_url: requiredProxyBinding(env.BRAINBASE_CREDENTIAL_BROKER_URL),
      quota_url: requiredProxyBinding(env.BRAINBASE_QUOTA_URL),
      accounting_url: requiredProxyBinding(env.BRAINBASE_ACCOUNTING_URL),
      api_token: requiredProxyBinding(env.BRAINBASE_RUNTIME_API_TOKEN),
      timeout_ms: Number(env.BRAINBASE_RUNTIME_HTTP_TIMEOUT_MS ?? "5000"),
    });
    credentialFetch = createTenantCredentialFetch({
      envelope: resolved.tenant_context,
      expected_scope: resolved.expected_scope,
      broker: clients.credential_broker,
      credential_registry: createDurableTenantCredentialRegistry(env.TENANT_RUNTIME_STATE),
      credential_relay: env.TENANT_RUNTIME_STATE,
      read_authoritative_snapshot: () => clients.authority.read_workspace_connection(
        resolved.tenant_context.workspace_connection.connection_id,
      ),
      resolve_verification_key: (keyId) => resolveProxyVerificationKey(env, keyId),
      now: () => new Date().toISOString(),
      credential_header: credentialHeader,
    });
  } catch {
    return Response.json({ boundary: "credential_lease", error: "CONFIGURATION_INVALID" }, { status: 503 });
  }
  const headers = new Headers(request.headers);
  headers.delete(TENANT_BOUNDARY_HANDLE_HEADER);
  const proxyEnv: SandboxRuntimeEnv = {
    ...env,
    BRAINBASE_TASK_API_TOKEN: "tenant-credential-injected",
    SLACK_BOT_TOKEN: "tenant-credential-injected",
    NOCODB_TOKEN: "tenant-credential-injected",
    BRAINBASE_MCP_TOKEN: "tenant-credential-injected",
    GOOGLE_DRIVE_MCP_TOKEN: "tenant-credential-injected",
  };
  return handler(new Request(request, { headers }), credentialFetch, proxyEnv);
}

function requiredProxyBinding(value: string | undefined): string {
  if (!value?.trim()) throw new Error("runtime_configuration_invalid");
  return value;
}

function runtimeDeploymentProfile(value: string | undefined): DeploymentProfileName {
  if (value !== "shared_cloud" && value !== "dedicated_cloud" && value !== "customer_managed_oss") {
    throw new Error("runtime_configuration_invalid");
  }
  return value;
}

async function resolveProxyVerificationKey(env: SandboxRuntimeEnv, keyId: string): Promise<CryptoKey | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredProxyBinding(env.BRAINBASE_TENANT_CONTEXT_JWKS_JSON));
  } catch {
    return undefined;
  }
  const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && Array.isArray((parsed as { keys?: unknown }).keys)
    ? (parsed as { keys: JsonWebKey[] }).keys
    : [];
  const matches = keys.filter((key) => (key as JsonWebKey & { kid?: string }).kid === keyId
    && key.kty === "OKP" && key.crv === "Ed25519" && (key.use === undefined || key.use === "sig"));
  if (matches.length !== 1) return undefined;
  try {
    return await crypto.subtle.importKey("jwk", matches[0], { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return undefined;
  }
}

TechKnightSandbox.outboundByHost = {
  "api.anthropic.com": async (request: Request, _env: SandboxRuntimeEnv) => {
    return forwardTenantCredentialRequest(_env.TENANT_RUNTIME_STATE, request, new Date().toISOString());
  },
  "github.com": async (request: Request, env: SandboxRuntimeEnv) => {
    return forwardTenantCredentialRequest(
      env.TENANT_RUNTIME_STATE,
      request,
      new Date().toISOString(),
      "github-basic",
    );
  },
  [DEVELOPMENT_CALLBACK_PROXY_HOST]: async (request: Request, env: SandboxRuntimeEnv) => {
    if (!env.DEVELOPMENT_CALLBACK_BASE_URL || !env.DEVELOPMENT_CALLBACK_TOKEN) {
      return new Response("development_callback_not_configured", { status: 503 });
    }
    const base = new URL(env.DEVELOPMENT_CALLBACK_BASE_URL);
    if (base.protocol !== "https:" || base.username || base.password) {
      return new Response("development_callback_not_configured", { status: 503 });
    }
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${env.DEVELOPMENT_CALLBACK_TOKEN}`);
    return fetch(`${base.origin}${base.pathname.replace(/\/$/, "")}/development/callback`, {
      method: request.method,
      headers,
      body: request.body,
    });
  },
  [TASK_SEARCH_PROXY_HOST]: (request, env: SandboxRuntimeEnv) => authorizeTenantRuntimeProxy(
    request, env, (authorized, credentialFetch, proxyEnv) =>
      createTaskSearchProxyHandler(credentialFetch)(authorized, proxyEnv),
  ),
  [TASK_WRITE_PROXY_HOST]: (request, env: SandboxRuntimeEnv) => authorizeTenantRuntimeProxy(
    request, env, (authorized, credentialFetch, proxyEnv) =>
      createTaskWriteProxyHandler(credentialFetch)(authorized, proxyEnv),
  ),
  [NOCODB_PROXY_HOST]: (request, env: SandboxRuntimeEnv) => authorizeTenantRuntimeProxy(
    request, env, (authorized, credentialFetch, proxyEnv) =>
      handleNocodbProxyRequest(authorized, proxyEnv, credentialFetch),
    "xc-token",
  ),
  [BRAINBASE_MCP_PROXY_HOST]: (request, env: SandboxRuntimeEnv) => authorizeTenantRuntimeProxy(
    request, env, (authorized, credentialFetch, proxyEnv) =>
      handleBrainbaseMcpProxyRequest(authorized, proxyEnv, credentialFetch),
  ),
  [GOOGLE_DRIVE_MCP_PROXY_HOST]: (request, env: SandboxRuntimeEnv) => authorizeTenantRuntimeProxy(
    request, env, (authorized, credentialFetch, proxyEnv) =>
      handleGoogleDriveMcpProxyRequest(authorized, proxyEnv, credentialFetch),
  ),
  [RUNTIME_GATEWAY_PROXY_HOST]: (request, env: SandboxRuntimeEnv) => authorizeTenantRuntimeProxy(
    request, env, (authorized, credentialFetch, proxyEnv) =>
      createRuntimeGatewayProxyHandler(credentialFetch)(authorized, proxyEnv),
  ),
};

export function createTechKnightSandbox(env: SandboxRuntimeEnv, id: string, sleepAfter = "1m") {
  return getSandbox(env.TECHKNIGHT_SANDBOX, id, {
    enableDefaultSession: false,
    sleepAfter,
  });
}
