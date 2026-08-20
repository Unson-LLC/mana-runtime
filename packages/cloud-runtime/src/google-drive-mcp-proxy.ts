export const GOOGLE_DRIVE_MCP_PROXY_HOST = "google-drive-mcp.internal";
export const GOOGLE_DRIVE_MCP_PROXY_PATH = "/mcp";

export interface GoogleDriveMcpProxyEnv {
  GOOGLE_DRIVE_MCP_BASE_URL?: string;
  GOOGLE_DRIVE_MCP_TOKEN?: string;
}

export async function handleGoogleDriveMcpProxyRequest(
  request: Request,
  env: GoogleDriveMcpProxyEnv,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== GOOGLE_DRIVE_MCP_PROXY_HOST || url.pathname !== GOOGLE_DRIVE_MCP_PROXY_PATH || request.method !== "POST") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (!env.GOOGLE_DRIVE_MCP_BASE_URL || (!env.GOOGLE_DRIVE_MCP_TOKEN && !fetchImpl)) {
    return Response.json({ error: "google_drive_mcp_not_configured" }, { status: 503 });
  }
  const headers = new Headers(request.headers);
  if (env.GOOGLE_DRIVE_MCP_TOKEN) headers.set("authorization", `Bearer ${env.GOOGLE_DRIVE_MCP_TOKEN}`);
  else headers.delete("authorization");
  headers.delete("cookie");
  const response = await (fetchImpl ?? fetch)(`${env.GOOGLE_DRIVE_MCP_BASE_URL.replace(/\/$/, "")}${GOOGLE_DRIVE_MCP_PROXY_PATH}`, {
    method: "POST",
    headers,
    body: request.body,
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
  });
  return response.status >= 300 && response.status < 400
    ? Response.json({ error: "google_drive_mcp_redirect_rejected" }, { status: 502 })
    : response;
}
