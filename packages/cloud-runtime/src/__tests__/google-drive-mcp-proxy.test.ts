import { describe, expect, it, vi } from "vitest";
import { handleGoogleDriveMcpProxyRequest } from "../google-drive-mcp-proxy.js";

describe("Google Drive MCP proxy", () => {
  it("injects the server-side bearer token and preserves MCP responses", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer drive-secret");
      return Response.json({ jsonrpc: "2.0", result: { tools: [] } });
    }) as unknown as typeof fetch;
    const response = await handleGoogleDriveMcpProxyRequest(
      new Request("https://google-drive-mcp.internal/mcp", { method: "POST", body: "{}" }),
      { GOOGLE_DRIVE_MCP_BASE_URL: "https://bb.unson.jp/runtime-google-drive", GOOGLE_DRIVE_MCP_TOKEN: "drive-secret" },
      fetchImpl,
    );
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://bb.unson.jp/runtime-google-drive/mcp",
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
  });

  it("rejects upstream redirects without following them", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 307, headers: { location: "https://evil.example" } })) as unknown as typeof fetch;
    const response = await handleGoogleDriveMcpProxyRequest(
      new Request("https://google-drive-mcp.internal/mcp", { method: "POST", body: "{}" }),
      { GOOGLE_DRIVE_MCP_BASE_URL: "https://bb.unson.jp/runtime-google-drive", GOOGLE_DRIVE_MCP_TOKEN: "drive-secret" }, fetchImpl,
    );
    expect(response.status).toBe(502);
  });

  it("fails closed for missing credentials and non-MCP paths", async () => {
    expect((await handleGoogleDriveMcpProxyRequest(new Request("https://google-drive-mcp.internal/mcp", { method: "POST" }), {})).status).toBe(503);
    expect((await handleGoogleDriveMcpProxyRequest(new Request("https://google-drive-mcp.internal/health"), {})).status).toBe(404);
  });
});
