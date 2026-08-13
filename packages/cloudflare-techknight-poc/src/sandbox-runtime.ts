import { Sandbox as BaseSandbox, getSandbox } from "@cloudflare/sandbox";

import type { SandboxAdminEnv } from "./sandbox-admin.js";
import {
  handleTaskSearchProxyRequest,
  TASK_SEARCH_PROXY_HOST,
} from "./task-search-proxy.js";
import { handleTaskWriteProxyRequest, TASK_WRITE_PROXY_HOST } from "./task-write-proxy.js";
import type { TaskBoardRepairEvent } from "./task-board.js";

export { ContainerProxy } from "@cloudflare/sandbox";

export interface SandboxRuntimeEnv extends SandboxAdminEnv {
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
}

export class TechKnightSandbox extends BaseSandbox<SandboxRuntimeEnv> {
  interceptHttps = true;
  enableInternet = false;
  allowedHosts = ["api.anthropic.com", TASK_SEARCH_PROXY_HOST, TASK_WRITE_PROXY_HOST];
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
  [TASK_SEARCH_PROXY_HOST]: handleTaskSearchProxyRequest,
  [TASK_WRITE_PROXY_HOST]: handleTaskWriteProxyRequest,
};

export function createTechKnightSandbox(env: SandboxRuntimeEnv, id: string) {
  return getSandbox(env.TECHKNIGHT_SANDBOX, id, {
    enableDefaultSession: false,
    sleepAfter: "1m",
  });
}
