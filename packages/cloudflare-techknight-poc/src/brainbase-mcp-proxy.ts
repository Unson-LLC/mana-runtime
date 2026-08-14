export const BRAINBASE_MCP_PROXY_HOST = "brainbase-mcp.internal";
export const BRAINBASE_MCP_PROXY_PATH = "/mcp";

export interface BrainbaseMcpProxyEnv {
  BRAINBASE_MCP_BASE_URL?: string;
  BRAINBASE_MCP_TOKEN?: string;
}

export async function handleBrainbaseMcpProxyRequest(request: Request, env: BrainbaseMcpProxyEnv, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== BRAINBASE_MCP_PROXY_HOST || url.pathname !== BRAINBASE_MCP_PROXY_PATH || request.method !== "POST") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (!env.BRAINBASE_MCP_BASE_URL || !env.BRAINBASE_MCP_TOKEN) {
    return Response.json({ error: "brainbase_mcp_not_configured" }, { status: 503 });
  }
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${env.BRAINBASE_MCP_TOKEN}`);
  headers.delete("cookie");
  return fetchImpl(`${env.BRAINBASE_MCP_BASE_URL.replace(/\/$/, "")}${BRAINBASE_MCP_PROXY_PATH}`, {
    method: "POST", headers, body: request.body, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
}
