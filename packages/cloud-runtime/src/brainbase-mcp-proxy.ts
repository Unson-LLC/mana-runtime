export const BRAINBASE_MCP_PROXY_HOST = "brainbase-mcp.internal";
export const BRAINBASE_MCP_PROXY_PATH = "/mcp";
export const BRAINBASE_JUDGMENT_HOOK_PROXY_PATH = "/host/judgment/hook";

export interface BrainbaseMcpProxyEnv {
  BRAINBASE_MCP_BASE_URL?: string;
  BRAINBASE_MCP_TOKEN?: string;
  BRAINBASE_JUDGMENT_PROJECT_CODE?: string;
  /** Canonical Company Authority project ID to judgment Hook project code. */
  BRAINBASE_JUDGMENT_AUTHORITY_PROJECTS_JSON?: string;
}

async function mcpToolName(request: Request): Promise<string | undefined> {
  if (new URL(request.url).pathname !== BRAINBASE_MCP_PROXY_PATH) return undefined;
  try {
    const body = await request.clone().json() as { method?: unknown; params?: { name?: unknown } };
    return body.method === "tools/call" && typeof body.params?.name === "string"
      ? body.params.name.slice(0, 120) : undefined;
  } catch { return undefined; }
}

export async function handleBrainbaseMcpProxyRequest(
  request: Request,
  env: BrainbaseMcpProxyEnv,
  fetchImpl?: typeof fetch,
  policy?: { allowedTools: readonly string[] },
): Promise<Response> {
  const url = new URL(request.url);
  const isAllowedPath = url.pathname === BRAINBASE_MCP_PROXY_PATH || url.pathname === BRAINBASE_JUDGMENT_HOOK_PROXY_PATH;
  const allowedMethod = url.pathname === BRAINBASE_MCP_PROXY_PATH
    ? ["POST", "GET", "DELETE"].includes(request.method)
    : request.method === "POST";
  if (url.hostname !== BRAINBASE_MCP_PROXY_HOST || !isAllowedPath || !allowedMethod) {
    return Response.json({ error: { code: "BRAINBASE_OPERATION_FORBIDDEN", retryable: false } }, { status: 403 });
  }
  // This policy is supplied by the verified durable boundary, never by model
  // request headers. Tool discovery/annotations do not authorize tool calls.
  if (policy && url.pathname === BRAINBASE_MCP_PROXY_PATH && request.method === "POST") {
    let allowed = false;
    try {
      const body = await request.clone().json() as Record<string, unknown>;
      if (body && !Array.isArray(body) && body.jsonrpc === "2.0") {
        const params = body.params as { name?: unknown } | undefined;
        allowed = ["initialize", "notifications/initialized", "ping", "tools/list"].includes(String(body.method))
          || (body.method === "tools/call" && typeof params?.name === "string"
            && policy.allowedTools.includes(params.name));
      }
    } catch { /* Malformed/batch requests cannot bypass the operation gate. */ }
    if (!allowed) return Response.json({
      error: { code: "COMPANY_AUTHORITY_OPERATION_FORBIDDEN", retryable: false },
    }, { status: 403 });
  }
  const toolName = await mcpToolName(request);
  if (!env.BRAINBASE_MCP_BASE_URL || (!env.BRAINBASE_MCP_TOKEN && !fetchImpl)) {
    return Response.json({ error: { code: "BRAINBASE_PROXY_NOT_CONFIGURED", retryable: true } }, { status: 503 });
  }
  const headers = new Headers();
  for (const name of ["accept", "content-type", "user-agent", "mcp-session-id"] as const) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (env.BRAINBASE_MCP_TOKEN) headers.set("authorization", `Bearer ${env.BRAINBASE_MCP_TOKEN}`);
  if (url.pathname === BRAINBASE_JUDGMENT_HOOK_PROXY_PATH) {
    const projectCode = env.BRAINBASE_JUDGMENT_PROJECT_CODE?.trim();
    if (!projectCode) {
      return Response.json({ error: { code: "BRAINBASE_PROXY_NOT_CONFIGURED", retryable: true } }, { status: 503 });
    }
    headers.set("x-brainbase-project-code", projectCode);
  }
  try {
    const response = await (fetchImpl ?? fetch)(`${env.BRAINBASE_MCP_BASE_URL.replace(/\/$/, "")}${url.pathname}`, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      return Response.json({ error: { code: "BRAINBASE_UPSTREAM_REDIRECT_REJECTED", retryable: false } }, { status: 502 });
    }
    if (toolName) {
      const diagnostic = await response.clone().text();
      console.log(JSON.stringify({
        event: "brainbase_mcp_tool_result",
        toolName,
        status: response.status,
        isError: /"isError"\s*:\s*true/u.test(diagnostic),
        errorCode: diagnostic.match(/\b(?:judgment|brainbase)_[a-z0-9_]{1,80}\b/u)?.[0] ?? null,
      }));
    }
    const responseHeaders = new Headers({
      "content-type": response.headers.get("content-type") ?? "application/json",
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) responseHeaders.set("mcp-session-id", sessionId);
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch {
    return Response.json({ error: { code: "BRAINBASE_UPSTREAM_UNAVAILABLE", retryable: true } }, { status: 502 });
  }
}
