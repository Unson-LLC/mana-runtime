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
    return Response.json({ error: { code: "BRAINBASE_OPERATION_FORBIDDEN", retryable: false } }, { status: 403 });
  }
  if (!env.BRAINBASE_MCP_BASE_URL || (!env.BRAINBASE_MCP_TOKEN && !fetchImpl)) {
    return Response.json({ error: { code: "BRAINBASE_PROXY_NOT_CONFIGURED", retryable: true } }, { status: 503 });
  }
  const headers = new Headers();
  for (const name of ["accept", "content-type", "user-agent"] as const) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (env.BRAINBASE_MCP_TOKEN) headers.set("authorization", `Bearer ${env.BRAINBASE_MCP_TOKEN}`);
  if (url.pathname === BRAINBASE_JUDGMENT_HOOK_PROXY_PATH) {
    headers.set("x-brainbase-project-code", "mana-runtime");
  }
  try {
    const response = await (fetchImpl ?? fetch)(`${env.BRAINBASE_MCP_BASE_URL.replace(/\/$/, "")}${url.pathname}`, {
      method: "POST", headers, body: request.body, redirect: "manual", signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      return Response.json({ error: { code: "BRAINBASE_UPSTREAM_REDIRECT_REJECTED", retryable: false } }, { status: 502 });
    }
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return Response.json({ error: { code: "BRAINBASE_UPSTREAM_UNAVAILABLE", retryable: true } }, { status: 502 });
  }
}
