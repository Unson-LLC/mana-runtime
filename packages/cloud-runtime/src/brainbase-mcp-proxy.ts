export const BRAINBASE_MCP_PROXY_HOST = "brainbase-mcp.internal";
export const BRAINBASE_MCP_PROXY_PATH = "/mcp";
export const BRAINBASE_JUDGMENT_HOOK_PROXY_PATH = "/host/judgment/hook";

export interface BrainbaseMcpProxyEnv {
  BRAINBASE_MCP_BASE_URL?: string;
  BRAINBASE_MCP_TOKEN?: string;
}

export async function handleBrainbaseMcpProxyRequest(request: Request, env: BrainbaseMcpProxyEnv, fetchImpl?: typeof fetch): Promise<Response> {
  const url = new URL(request.url);
  const isAllowedPath = url.pathname === BRAINBASE_MCP_PROXY_PATH || url.pathname === BRAINBASE_JUDGMENT_HOOK_PROXY_PATH;
  if (url.hostname !== BRAINBASE_MCP_PROXY_HOST || !isAllowedPath || request.method !== "POST") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (!env.BRAINBASE_MCP_BASE_URL || (!env.BRAINBASE_MCP_TOKEN && !fetchImpl)) {
    return Response.json({ error: "brainbase_mcp_not_configured" }, { status: 503 });
  }
  const headers = new Headers(request.headers);
  if (env.BRAINBASE_MCP_TOKEN) headers.set("authorization", `Bearer ${env.BRAINBASE_MCP_TOKEN}`);
  else headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("x-brainbase-project-code");
  if (url.pathname === BRAINBASE_JUDGMENT_HOOK_PROXY_PATH) {
    headers.set("x-brainbase-project-code", "mana-runtime");
  }
  const response = await (fetchImpl ?? fetch)(`${env.BRAINBASE_MCP_BASE_URL.replace(/\/$/, "")}${url.pathname}`, {
    method: "POST", headers, body: request.body, redirect: "manual", signal: AbortSignal.timeout(30_000),
  });
  return response.status >= 300 && response.status < 400
    ? Response.json({ error: "brainbase_mcp_redirect_rejected" }, { status: 502 })
    : response;
}
