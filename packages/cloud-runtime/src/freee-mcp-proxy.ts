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

type McpBodyInspection = {
  readOnly: boolean;
  requestsToolsList: boolean;
};

function inspectRequest(value: unknown): McpBodyInspection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { readOnly: true, requestsToolsList: false };
  }
  const rpc = value as { method?: unknown; params?: unknown };
  if (rpc.method === "tools/list") return { readOnly: true, requestsToolsList: true };
  if (rpc.method !== "tools/call") return { readOnly: true, requestsToolsList: false };
  if (!rpc.params || typeof rpc.params !== "object" || Array.isArray(rpc.params)) {
    return { readOnly: false, requestsToolsList: false };
  }
  const name = (rpc.params as { name?: unknown }).name;
  return {
    readOnly: typeof name === "string" && READ_ONLY_TOOLS.has(name),
    requestsToolsList: false,
  };
}

function inspectMcpBody(body: string): McpBodyInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Let the upstream MCP server return the canonical JSON-RPC parse error.
    return { readOnly: true, requestsToolsList: false };
  }
  if (!Array.isArray(parsed)) return inspectRequest(parsed);
  return parsed.reduce<McpBodyInspection>((state, child) => {
    const inspected = inspectRequest(child);
    return {
      readOnly: state.readOnly && inspected.readOnly,
      requestsToolsList: state.requestsToolsList || inspected.requestsToolsList,
    };
  }, { readOnly: true, requestsToolsList: false });
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

function filterTools(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(filterTools);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const result = record.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return value;
  const resultRecord = result as Record<string, unknown>;
  if (!Array.isArray(resultRecord.tools)) return value;
  return {
    ...record,
    result: {
      ...resultRecord,
      tools: resultRecord.tools.filter((tool) => {
        if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
        const name = (tool as { name?: unknown }).name;
        return typeof name === "string" && READ_ONLY_TOOLS.has(name);
      }),
    },
  };
}

function filteredHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return headers;
}

async function filterToolsListResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      return Response.json({ error: "freee_mcp_invalid_tools_list" }, { status: 502 });
    }
    return new Response(JSON.stringify(filterTools(payload)), {
      status: response.status,
      headers: filteredHeaders(response),
    });
  }
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    const lines = text.split("\n");
    const filtered = [];
    for (const line of lines) {
      if (!line.startsWith("data:")) {
        filtered.push(line);
        continue;
      }
      const data = line.slice(5).trimStart();
      if (!data || data === "[DONE]") {
        filtered.push(line);
        continue;
      }
      try {
        filtered.push(`data: ${JSON.stringify(filterTools(JSON.parse(data)))}`);
      } catch {
        return Response.json({ error: "freee_mcp_invalid_tools_list" }, { status: 502 });
      }
    }
    return new Response(filtered.join("\n"), {
      status: response.status,
      headers: filteredHeaders(response),
    });
  }
  return Response.json({ error: "freee_mcp_invalid_tools_list_content_type" }, { status: 502 });
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
  const inspection = inspectMcpBody(body);
  if (!inspection.readOnly) {
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
  if (response.status >= 300 && response.status < 400) {
    return Response.json({ error: "freee_mcp_redirect_rejected" }, { status: 502 });
  }
  return inspection.requestsToolsList ? filterToolsListResponse(response) : response;
}

export { READ_ONLY_TOOLS as FREEE_MCP_READ_ONLY_TOOLS };
