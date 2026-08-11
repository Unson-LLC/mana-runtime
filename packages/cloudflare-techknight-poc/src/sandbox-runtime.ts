import { Sandbox as BaseSandbox, getSandbox } from "@cloudflare/sandbox";

import type { SandboxAdminEnv } from "./sandbox-admin.js";

export { ContainerProxy } from "@cloudflare/sandbox";

export interface SandboxRuntimeEnv extends SandboxAdminEnv {
  TECHKNIGHT_SANDBOX: DurableObjectNamespace<TechKnightSandbox>;
}

export class TechKnightSandbox extends BaseSandbox<SandboxRuntimeEnv> {
  interceptHttps = true;
  enableInternet = false;
  allowedHosts = ["api.anthropic.com"];
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
};

export function createTechKnightSandbox(env: SandboxRuntimeEnv, id: string) {
  return getSandbox(env.TECHKNIGHT_SANDBOX, id, {
    enableDefaultSession: false,
    sleepAfter: "1m",
  });
}
