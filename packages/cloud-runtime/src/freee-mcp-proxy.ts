export const FREEE_MCP_PROXY_HOST = "freee-mcp.internal";
export const FREEE_MCP_PROXY_PATH = "/mcp";
export const FREEE_MCP_DEFAULT_BASE_URL = "https://mcp.freee.co.jp";

export interface FreeeMcpProxyEnv {
  FREEE_MCP_BASE_URL?: string;
}

const READ_ONLY_TOOLS = new Set([
  "freee_api_get",
  "freee_api_list_paths",
  "freee_auth_status",
  "freee_get_current_company",
  "freee_list_companies",
  "freee_current_user",
  "freee_server_info",
  // Changes only the MCP session/account selection; it does not mutate freee business data.
  "freee_set_current_company",
]);

function readOnlyRequest(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const rpc = value as { method?: unknown; params?: unknown };
  if (rpc.method !== "tools/call") return true;
  if (!rpc.params || typeof rpc.params !== "object" || Array.isArray(rpc.params)) return false;
  const name = (rpc.params as { name?: unknown }).name;
  return typeof name === "string" && READ_ONLY_TOOLS.has(name);
}

function assertReadOnlyMcpBody(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Let the upstream MCP server return the canonical JSON-RPC parse error.
    return true;
  }
  return Array.isArray(parsed) ? parsed.every(readOnlyRequest) : readOnlyRequest(parsed);
}

function configuredBaseUrl(value: string | undefined): string | null {
  const raw = value?.trim() || FREEE_MCP_DEFAULT_BASE_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

export async function handleFreeeMcpProxyRequest(
  request: Request,
  env: FreeeMcpProxyEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== FREEE_MCP_PROXY_HOST || url.pathname !== FREEE_MCP_PROXY_PATH || request.method !== "POST") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const baseUrl = configuredBaseUrl(env.FREEE_MCP_BASE_URL);
  if (!baseUrl) return Response.json({ error: "freee_mcp_not_configured" }, { status: 503 });

  const body = await request.clone().text();
  if (!assertReadOnlyMcpBody(body)) {
    return Response.json({
      error: "freee_mcp_read_only",
      message: "This Mana connection allows freee read operations only.",
    }, { status: 403 });
  }

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("proxy-authorization");
  headers.delete("cookie");
  headers.delete("content-length");

  const response = await fetchImpl(`${baseUrl}${FREEE_MCP_PROXY_PATH}`, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
  });
  return response.status >= 300 && response.status < 400
    ? Response.json({ error: "freee_mcp_redirect_rejected" }, { status: 502 })
    : response;
}

export { READ_ONLY_TOOLS as FREEE_MCP_READ_ONLY_TOOLS };
