import { Sandbox as BaseSandbox, getSandbox } from "@cloudflare/sandbox";

import type { SandboxAdminEnv } from "./sandbox-admin.js";
import {
  forwardTenantCredentialRequest,
  type TenantCredentialRelayNamespace,
} from "./multitenancy/durable-credential-relay.js";
import {
  authorizeDurableTenantBoundaryRequest,
  TENANT_BOUNDARY_HANDLE_HEADER,
  type TenantBoundaryContextNamespace,
} from "./multitenancy/durable-tenant-boundary.js";
import {
  handleTaskSearchProxyRequest,
  TASK_SEARCH_PROXY_HOST,
} from "./task-search-proxy.js";
import { handleTaskWriteProxyRequest, TASK_WRITE_PROXY_HOST } from "./task-write-proxy.js";
import type { TaskBoardRepairEvent } from "./task-board.js";
import { handleNocodbProxyRequest, NOCODB_PROXY_HOST, type NocodbProxyEnv } from "./nocodb-proxy.js";
import { BRAINBASE_MCP_PROXY_HOST, handleBrainbaseMcpProxyRequest, type BrainbaseMcpProxyEnv } from "./brainbase-mcp-proxy.js";
import { GOOGLE_DRIVE_MCP_PROXY_HOST, handleGoogleDriveMcpProxyRequest, type GoogleDriveMcpProxyEnv } from "./google-drive-mcp-proxy.js";
import { handleRuntimeGatewayProxyRequest, RUNTIME_GATEWAY_PROXY_HOST, type RuntimeGatewayProxyEnv } from "./runtime-gateway-proxy.js";

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
  GITHUB_TOKEN?: string;
  DEVELOPMENT_CALLBACK_BASE_URL?: string;
  DEVELOPMENT_CALLBACK_TOKEN?: string;
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
  handler: (request: Request) => Promise<Response> | Response,
): Promise<Response> {
  const now = new Date().toISOString();
  const mcpFailure = await authorizeDurableTenantBoundaryRequest(
    env.TENANT_RUNTIME_STATE,
    request,
    "mcp_gateway",
    now,
  );
  if (mcpFailure) return mcpFailure;
  const proxyFailure = await authorizeDurableTenantBoundaryRequest(
    env.TENANT_RUNTIME_STATE,
    request,
    "brainbase_proxy",
    now,
  );
  if (proxyFailure) return proxyFailure;
  const headers = new Headers(request.headers);
  headers.delete(TENANT_BOUNDARY_HANDLE_HEADER);
  return handler(new Request(request, { headers }));
}

TechKnightSandbox.outboundByHost = {
  "api.anthropic.com": async (request: Request, _env: SandboxRuntimeEnv) => {
    return forwardTenantCredentialRequest(_env.TENANT_RUNTIME_STATE, request, new Date().toISOString());
  },
  "github.com": async (request: Request, env: SandboxRuntimeEnv) => {
    if (!env.GITHUB_TOKEN) return new Response("github_not_configured", { status: 503 });
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    // Git smart-HTTP authenticates a PAT as the HTTPS password. Keep the
    // credential outside the container and translate the intercepted request
    // at the Worker boundary.
    headers.set("Authorization", `Basic ${btoa(`x-access-token:${env.GITHUB_TOKEN}`)}`);
    return fetch(`https://github.com${url.pathname}${url.search}`, { method: request.method, headers, body: request.body });
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
    request, env, (authorized) => handleTaskSearchProxyRequest(authorized, env),
  ),
  [TASK_WRITE_PROXY_HOST]: (request, env: SandboxRuntimeEnv) => authorizeTenantRuntimeProxy(
    request, env, (authorized) => handleTaskWriteProxyRequest(authorized, env),
  ),
  [NOCODB_PROXY_HOST]: (request, env: SandboxRuntimeEnv) => authorizeTenantRuntimeProxy(
    request, env, (authorized) => handleNocodbProxyRequest(authorized, env),
  ),
  [BRAINBASE_MCP_PROXY_HOST]: (request, env: SandboxRuntimeEnv) => authorizeTenantRuntimeProxy(
    request, env, (authorized) => handleBrainbaseMcpProxyRequest(authorized, env),
  ),
  [GOOGLE_DRIVE_MCP_PROXY_HOST]: (request, env: SandboxRuntimeEnv) => authorizeTenantRuntimeProxy(
    request, env, (authorized) => handleGoogleDriveMcpProxyRequest(authorized, env),
  ),
  [RUNTIME_GATEWAY_PROXY_HOST]: (request, env: SandboxRuntimeEnv) => authorizeTenantRuntimeProxy(
    request, env, (authorized) => handleRuntimeGatewayProxyRequest(authorized, env),
  ),
};

export function createTechKnightSandbox(env: SandboxRuntimeEnv, id: string, sleepAfter = "1m") {
  return getSandbox(env.TECHKNIGHT_SANDBOX, id, {
    enableDefaultSession: false,
    sleepAfter,
  });
}
