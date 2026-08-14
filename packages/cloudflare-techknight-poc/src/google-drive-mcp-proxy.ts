export const GOOGLE_DRIVE_MCP_PROXY_HOST = "google-drive-mcp.internal";
export const GOOGLE_DRIVE_MCP_PROXY_PATH = "/mcp";

export interface GoogleDriveMcpProxyEnv {
  GOOGLE_DRIVE_MCP_BASE_URL?: string;
  GOOGLE_DRIVE_MCP_TOKEN?: string;
}

export async function handleGoogleDriveMcpProxyRequest(
  request: Request,
  env: GoogleDriveMcpProxyEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== GOOGLE_DRIVE_MCP_PROXY_HOST || url.pathname !== GOOGLE_DRIVE_MCP_PROXY_PATH || request.method !== "POST") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (!env.GOOGLE_DRIVE_MCP_BASE_URL || !env.GOOGLE_DRIVE_MCP_TOKEN) {
    return Response.json({ error: "google_drive_mcp_not_configured" }, { status: 503 });
  }
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${env.GOOGLE_DRIVE_MCP_TOKEN}`);
  headers.delete("cookie");
  return fetchImpl(`${env.GOOGLE_DRIVE_MCP_BASE_URL.replace(/\/$/, "")}${GOOGLE_DRIVE_MCP_PROXY_PATH}`, {
    method: "POST",
    headers,
    body: request.body,
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
}
