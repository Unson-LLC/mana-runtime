import { describe, expect, it, vi } from "vitest";
import { handleBrainbaseMcpProxyRequest } from "../brainbase-mcp-proxy.js";

describe("Brainbase MCP proxy", () => {
  it("injects the server-side bearer token without exposing it to the sandbox", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
      return Response.json({ jsonrpc: "2.0", result: {} });
    }) as unknown as typeof fetch;
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: "{}" }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.unson.jp/runtime-mcp", BRAINBASE_MCP_TOKEN: "secret-token" }, fetchImpl,
    );
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith("https://bb.unson.jp/runtime-mcp/mcp", expect.objectContaining({ method: "POST", redirect: "manual" }));
  });

  it("rejects upstream redirects without following them", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } })) as unknown as typeof fetch;
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: "{}" }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.unson.jp/runtime-mcp", BRAINBASE_MCP_TOKEN: "secret-token" }, fetchImpl,
    );
    expect(response.status).toBe(502);
  });

  it("story-meeting-minutes-brainbase-judgment:ac:5 forwards the judgment Hook with a trusted project binding", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer secret-token");
      expect(headers.get("x-brainbase-project-code")).toBe("mana-runtime");
      return Response.json({ decision: "allow" });
    }) as unknown as typeof fetch;
    const response = await handleBrainbaseMcpProxyRequest(new Request(
      "https://brainbase-mcp.internal/host/judgment/hook",
      { method: "POST", headers: { "x-brainbase-project-code": "attacker" }, body: "{}" },
    ), { BRAINBASE_MCP_BASE_URL: "https://bb.unson.jp/runtime-mcp", BRAINBASE_MCP_TOKEN: "secret-token" }, fetchImpl);
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith("https://bb.unson.jp/runtime-mcp/host/judgment/hook", expect.anything());
  });

  it("fails closed for missing credentials and paths outside /mcp", async () => {
    expect((await handleBrainbaseMcpProxyRequest(new Request("https://brainbase-mcp.internal/mcp", { method: "POST" }), {})).status).toBe(503);
    expect((await handleBrainbaseMcpProxyRequest(new Request("https://brainbase-mcp.internal/health"), {})).status).toBe(404);
  });
});
