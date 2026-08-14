import { Sandbox as BaseSandbox, getSandbox } from "@cloudflare/sandbox";

import type { SandboxAdminEnv } from "./sandbox-admin.js";
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
}

export const DEVELOPMENT_CALLBACK_PROXY_HOST = "development-callback.internal";

export class TechKnightSandbox extends BaseSandbox<SandboxRuntimeEnv> {
  interceptHttps = true;
  enableInternet = false;
  allowedHosts = ["api.anthropic.com", "github.com", DEVELOPMENT_CALLBACK_PROXY_HOST, TASK_SEARCH_PROXY_HOST, TASK_WRITE_PROXY_HOST, NOCODB_PROXY_HOST, BRAINBASE_MCP_PROXY_HOST, GOOGLE_DRIVE_MCP_PROXY_HOST, RUNTIME_GATEWAY_PROXY_HOST];
}

TechKnightSandbox.outboundByHost = {
  "api.anthropic.com": async (request: Request, env: SandboxRuntimeEnv) => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
      return new Response("oauth_not_configured", { status: 503 });
    }

    headers.set("Authorization", `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}`);
    headers.delete("x-api-key");
    return fetch(`https://api.anthropic.com${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body,
    });
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
  [TASK_SEARCH_PROXY_HOST]: handleTaskSearchProxyRequest,
  [TASK_WRITE_PROXY_HOST]: handleTaskWriteProxyRequest,
  [NOCODB_PROXY_HOST]: (request, env) => handleNocodbProxyRequest(request, env),
  [BRAINBASE_MCP_PROXY_HOST]: (request, env) => handleBrainbaseMcpProxyRequest(request, env),
  [GOOGLE_DRIVE_MCP_PROXY_HOST]: (request, env) => handleGoogleDriveMcpProxyRequest(request, env),
  [RUNTIME_GATEWAY_PROXY_HOST]: (request, env) => handleRuntimeGatewayProxyRequest(request, env),
};

export function createTechKnightSandbox(env: SandboxRuntimeEnv, id: string, sleepAfter = "1m") {
  return getSandbox(env.TECHKNIGHT_SANDBOX, id, {
    enableDefaultSession: false,
    sleepAfter,
  });
}
