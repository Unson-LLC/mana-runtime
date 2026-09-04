import { describe, expect, it, vi } from "vitest";
import { handleBrainbaseMcpProxyRequest } from "../brainbase-mcp-proxy.js";

describe("Brainbase judgment Hook proxy", () => {
  it.each([
    "{", "null", "[]",
    JSON.stringify([{ jsonrpc: "2.0", method: "tools/call", params: { name: "brainbase_admin_write" } }]),
    JSON.stringify({ jsonrpc: "2.0", method: "resources/read", params: { uri: "private://data" } }),
  ])("rejects malformed, batch and alternate A0 operations", async (body) => {
    const forward = vi.fn();
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" }, forward,
      { allowedTools: ["brainbase_resolve_turn"] },
    );
    expect(response.status).toBe(403);
    expect(forward).not.toHaveBeenCalled();
  });

  it.each(["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"])("preserves required A0 MCP operation %s", async (method) => {
    const forward = vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method,
        ...(method === "tools/call" ? { params: { name: "brainbase_resolve_turn", arguments: {} } } : {}),
      }) }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" }, forward,
      { allowedTools: ["brainbase_resolve_turn"] },
    );
    expect(response.status).toBe(200);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it.each(["brainbase_admin_write", "brainbase_graph_query", "unknown_tool"])("denies A0 tool %s before forwarding", async (name) => {
    const forward = vi.fn();
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} },
      }) }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" }, forward,
      { allowedTools: ["brainbase_resolve_turn", "brainbase_knowledge_resolve"] },
    );
    expect(response.status).toBe(403);
    expect(forward).not.toHaveBeenCalled();
  });

  it("forwards only the Hook with a fixed project binding and strict headers", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer secret-token");
      expect(headers.get("x-brainbase-project-code")).toBe("mana");
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-forwarded-for")).toBeNull();
      expect(headers.get("x-hostile-input")).toBeNull();
      return Response.json({ decision: "allow" });
    }) as unknown as typeof fetch;
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/host/judgment/hook", {
        method: "POST",
        headers: { cookie: "secret=1", "x-forwarded-for": "127.0.0.1", "x-hostile-input": "1" },
        body: "{}",
      }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.unson.jp/runtime-mcp", BRAINBASE_MCP_TOKEN: "secret-token", BRAINBASE_JUDGMENT_PROJECT_CODE: "mana" }, fetchImpl,
    );
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith("https://bb.unson.jp/runtime-mcp/host/judgment/hook", expect.objectContaining({ method: "POST", redirect: "manual" }));
  });

  it("rejects upstream redirects without following them", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } })) as unknown as typeof fetch;
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/host/judgment/hook", { method: "POST", body: "{}" }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.unson.jp/runtime-mcp", BRAINBASE_MCP_TOKEN: "secret-token", BRAINBASE_JUDGMENT_PROJECT_CODE: "mana" }, fetchImpl,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: "BRAINBASE_UPSTREAM_REDIRECT_REJECTED", retryable: false } });
  });

  it("returns a stable retryable error when the upstream is unavailable", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network detail must not leak"); }) as unknown as typeof fetch;
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/host/judgment/hook", { method: "POST", body: "{}" }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.unson.jp/runtime-mcp", BRAINBASE_MCP_TOKEN: "secret-token", BRAINBASE_JUDGMENT_PROJECT_CODE: "mana" }, fetchImpl,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: "BRAINBASE_UPSTREAM_UNAVAILABLE", retryable: true } });
  });

  it("keeps generic MCP on the caller-provided tenant credential transport", async () => {
    const tenantCredentialFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-brainbase-project-code")).toBeNull();
      return Response.json({ jsonrpc: "2.0", result: {} });
    }) as unknown as typeof fetch;
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: "{}" }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.unson.jp/runtime-mcp" }, tenantCredentialFetch,
    );
    expect(response.status).toBe(200);
    expect(tenantCredentialFetch).toHaveBeenCalledWith(
      "https://bb.unson.jp/runtime-mcp/mcp",
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
  });

  it("fails closed for missing credentials and all non-Hook operations", async () => {
    expect((await handleBrainbaseMcpProxyRequest(new Request("https://brainbase-mcp.internal/host/judgment/hook", { method: "POST" }), {})).status).toBe(503);
    expect((await handleBrainbaseMcpProxyRequest(new Request("https://brainbase-mcp.internal/mcp", { method: "POST" }), {})).status).toBe(503);
    expect((await handleBrainbaseMcpProxyRequest(new Request("https://brainbase-mcp.internal/health"), {})).status).toBe(403);
  });
});
