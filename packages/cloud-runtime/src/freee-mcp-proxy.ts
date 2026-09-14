export const FREEE_MCP_PROXY_HOST = "freee-mcp.internal";
export const FREEE_MCP_PROXY_PATH = "/mcp";

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
]);

const LIFECYCLE_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "ping",
  "tools/list",
]);

// The final Brainbase terminator owns the upstream freee session. Mana only
// carries protocol-neutral headers to the internal endpoint; upstream session
// identifiers must never be exposed to the sandbox.
const MCP_HEADER_ALLOWLIST = new Set([
  "accept",
  "content-type",
  "mcp-protocol-version",
]);

const MAX_FILTERED_RESPONSE_BYTES = 4 * 1024 * 1024;

type McpBodyInspection = {
  allowed: boolean;
  requestsToolsList: boolean;
};

function isJsonRpcResponse(value: Record<string, unknown>): boolean {
  if (value.jsonrpc !== "2.0" || Object.hasOwn(value, "method")) return false;
  const id = value.id;
  if (!(id === null || typeof id === "string" || typeof id === "number")) return false;
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  return hasResult !== hasError;
}

function inspectRequest(value: unknown): McpBodyInspection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { allowed: false, requestsToolsList: false };
  }
  const rpc = value as Record<string, unknown>;
  if (typeof rpc.method !== "string") {
    return { allowed: isJsonRpcResponse(rpc), requestsToolsList: false };
  }
  if (rpc.method === "tools/list") return { allowed: true, requestsToolsList: true };
  if (LIFECYCLE_METHODS.has(rpc.method)) return { allowed: true, requestsToolsList: false };
  if (rpc.method !== "tools/call") return { allowed: false, requestsToolsList: false };
  if (!rpc.params || typeof rpc.params !== "object" || Array.isArray(rpc.params)) {
    return { allowed: false, requestsToolsList: false };
  }
  const name = (rpc.params as { name?: unknown }).name;
  return {
    allowed: typeof name === "string" && READ_ONLY_TOOLS.has(name),
    requestsToolsList: false,
  };
}

function inspectMcpBody(body: string): McpBodyInspection | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return inspectRequest(parsed);
  if (parsed.length === 0) return { allowed: false, requestsToolsList: false };
  return parsed.reduce<McpBodyInspection>((state, child) => {
    const inspected = inspectRequest(child);
    return {
      allowed: state.allowed && inspected.allowed,
      requestsToolsList: state.requestsToolsList || inspected.requestsToolsList,
    };
  }, { allowed: true, requestsToolsList: false });
}

function configuredBaseUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
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

function allowedHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    if (MCP_HEADER_ALLOWLIST.has(name.toLowerCase())) headers.set(name, value);
  });
  return headers;
}

function normalizeResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: allowedHeaders(response.headers),
  });
}

async function readLimitedText(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FILTERED_RESPONSE_BYTES) return null;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FILTERED_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function filterToolsListResponse(response: Response): Promise<Response> {
  if (!response.ok) return normalizeResponse(response);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const text = await readLimitedText(response);
  if (text === null) return Response.json({ error: "freee_mcp_response_too_large" }, { status: 502 });
  if (contentType.includes("application/json")) {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return Response.json({ error: "freee_mcp_invalid_tools_list" }, { status: 502 });
    }
    return new Response(JSON.stringify(filterTools(payload)), {
      status: response.status,
      headers: allowedHeaders(response.headers),
    });
  }
  if (contentType.includes("text/event-stream")) {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/u);
    const filtered: string[] = [];
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
    return new Response(filtered.join(newline), {
      status: response.status,
      headers: allowedHeaders(response.headers),
    });
  }
  return Response.json({ error: "freee_mcp_invalid_tools_list_content_type" }, { status: 502 });
}

export async function handleFreeeMcpProxyRequest(
  request: Request,
  env: FreeeMcpProxyEnv,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== FREEE_MCP_PROXY_HOST || url.pathname !== FREEE_MCP_PROXY_PATH || request.method !== "POST") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const baseUrl = configuredBaseUrl(env.FREEE_MCP_BASE_URL);
  if (!baseUrl) return Response.json({ error: "freee_mcp_not_configured" }, { status: 503 });

  const body = await request.clone().text();
  const inspection = inspectMcpBody(body);
  if (!inspection) return Response.json({ error: "freee_mcp_invalid_json" }, { status: 400 });
  if (!inspection.allowed) {
    return Response.json({
      error: "freee_mcp_read_only",
      message: "This Mana connection allows only explicitly approved freee read operations.",
    }, { status: 403 });
  }

  const response = await fetchImpl(`${baseUrl}${FREEE_MCP_PROXY_PATH}`, {
    method: "POST",
    headers: allowedHeaders(request.headers),
    body,
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    return Response.json({ error: "freee_mcp_redirect_rejected" }, { status: 502 });
  }
  return inspection.requestsToolsList
    ? filterToolsListResponse(response)
    : normalizeResponse(response);
}

export { READ_ONLY_TOOLS as FREEE_MCP_READ_ONLY_TOOLS };
