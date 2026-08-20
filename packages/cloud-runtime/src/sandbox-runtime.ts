import { Sandbox as BaseSandbox, getSandbox } from "@cloudflare/sandbox";

import type { SandboxAdminEnv } from "./sandbox-admin.js";
import {
  resolveDurableTenantBoundaryContext,
  TENANT_BOUNDARY_HANDLE_HEADER,
  type AuthorizedTenantBoundaryContext,
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
import {
  authorizeTenantProviderOutbound,
  tenantCredentialFetchForResolvedContext,
} from "./multitenancy/tenant-provider-outbound.js";
import { deliverTenantGatewaySlackMessage } from "./multitenancy/tenant-gateway-delivery.js";
import { proxyDevelopmentCallback } from "./multitenancy/development-callback-proxy.js";

export { ContainerProxy } from "@cloudflare/sandbox";
export { proxyDevelopmentCallback } from "./multitenancy/development-callback-proxy.js";

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
  BRAINBASE_TENANT_RUNTIME_ENABLED?: string;
  BRAINBASE_TENANT_RUNTIME_HOST?: string;
  BRAINBASE_TENANT_RUNTIME_PORT?: string;
  BRAINBASE_TENANT_RUNTIME_ALLOW_NON_LOOPBACK?: string;
  BRAINBASE_TENANT_RUNTIME_SERVICE_TOKEN?: string;
  BRAINBASE_TENANT_RUNTIME_SERVICE?: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  TENANT_RUNTIME_STATE: TenantBoundaryContextNamespace;
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
  handler: (request: Request, credentialFetch: typeof fetch, proxyEnv: SandboxRuntimeEnv,
    resolved: AuthorizedTenantBoundaryContext) => Promise<Response> | Response,
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
    credentialFetch = tenantCredentialFetchForResolvedContext(env, resolved);
  } catch {
    return Response.json({ boundary: "credential_lease", error: "CONFIGURATION_INVALID" }, { status: 503 });
  }
  const headers = new Headers(request.headers);
  headers.delete(TENANT_BOUNDARY_HANDLE_HEADER);
  const proxyEnv: SandboxRuntimeEnv = {
    ...env,
    SLACK_EXPECTED_TEAM_ID: resolved.tenant_context.workspace_connection.workspace_id,
    BRAINBASE_TASK_API_TOKEN: undefined,
    SLACK_BOT_TOKEN: undefined,
    NOCODB_TOKEN: undefined,
    BRAINBASE_MCP_TOKEN: undefined,
    GOOGLE_DRIVE_MCP_TOKEN: undefined,
  };
  return handler(new Request(request, { headers }), credentialFetch, proxyEnv, resolved);
}

TechKnightSandbox.outboundByHost = {
  "api.anthropic.com": async (request: Request, env: SandboxRuntimeEnv) => {
    return authorizeTenantProviderOutbound(request, env);
  },
  "github.com": async (request: Request, env: SandboxRuntimeEnv) => {
    return authorizeTenantProviderOutbound(request, env);
  },
  [DEVELOPMENT_CALLBACK_PROXY_HOST]: async (request: Request, env: SandboxRuntimeEnv) => {
    return proxyDevelopmentCallback(request, env);
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
    request, env, (authorized, credentialFetch, proxyEnv, resolved) =>
      createRuntimeGatewayProxyHandler(credentialFetch, {
        deliverSlackMessage: (input) => deliverTenantGatewaySlackMessage(
          input,
          proxyEnv,
          resolved,
          credentialFetch,
        ),
      })(authorized, proxyEnv),
  ),
};

export function createTechKnightSandbox(env: SandboxRuntimeEnv, id: string, sleepAfter = "1m") {
  return getSandbox(env.TECHKNIGHT_SANDBOX, id, {
    enableDefaultSession: false,
    sleepAfter,
  });
}
