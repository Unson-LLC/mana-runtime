import { describe, expect, it, vi } from "vitest";
import { handleBrainbaseMcpProxyRequest } from "../brainbase-mcp-proxy.js";

describe("Brainbase judgment Hook proxy", () => {
  it("rejects the unsupported MCP notification stream without contacting upstream", async () => {
    const forward = vi.fn();
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "mcp-session-id": "session-transport",
          "mcp-protocol-version": "2025-06-18",
        },
      }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.example.test", BRAINBASE_MCP_TOKEN: "token" },
      forward,
      { allowedTools: ["brainbase_resolve_turn"] },
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, DELETE");
    expect(await response.json()).toEqual({
      error: { code: "BRAINBASE_MCP_NOTIFICATION_STREAM_UNSUPPORTED", retryable: false },
    });
    expect(forward).not.toHaveBeenCalled();
  });

  it("forwards the DELETE MCP session transport request", async () => {
    const method = "DELETE";
    const forward = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://bb.example.test/mcp");
      expect(init?.method).toBe(method);
      expect(new Headers(init?.headers).get("mcp-session-id")).toBe("session-transport");
      expect(new Headers(init?.headers).get("mcp-protocol-version")).toBe("2025-06-18");
      expect(init?.body).toBeUndefined();
      return new Response(null, { status: 204 });
    });
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", {
        method,
        headers: {
          "mcp-session-id": "session-transport",
          "mcp-protocol-version": "2025-06-18",
        },
      }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.example.test", BRAINBASE_MCP_TOKEN: "token" },
      forward as typeof fetch,
      { allowedTools: ["brainbase_resolve_turn"] },
    );
    expect(response.status).toBe(204);
  });

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
    const forward = vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1,
      result: method === "tools/list" ? { tools: [{ name: "brainbase_resolve_turn" }] } : {} }));
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

  it("forwards the MCP session ID in both directions", async () => {
    const forward = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("mcp-session-id")).toBe("session-123");
      return Response.json(
        { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "brainbase_resolve_turn" }] } },
        { headers: { "mcp-session-id": "session-456" } },
      );
    }) as unknown as typeof fetch;
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", {
        method: "POST",
        headers: { "mcp-session-id": "session-123" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" }, forward,
      { allowedTools: ["brainbase_resolve_turn"] },
    );
    expect(response.headers.get("mcp-session-id")).toBe("session-456");
  });

  it("exposes only company-authorized tools in a JSON catalog", async () => {
    const forward = vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [
      { name: "brainbase_resolve_turn", inputSchema: { type: "object" } },
      { name: "brainbase_knowledge_resolve", inputSchema: { type: "object" } },
      { name: "brainbase_admin_write", inputSchema: { type: "object" } },
    ] } })) as unknown as typeof fetch;
    const response = await handleBrainbaseMcpProxyRequest(
      new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
      }) }),
      { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" }, forward,
      { allowedTools: ["brainbase_resolve_turn", "brainbase_knowledge_resolve"] },
    );
    const body = await response.json() as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "brainbase_resolve_turn", "brainbase_knowledge_resolve",
    ]);
  });

  it("filters an event-stream catalog and fails closed for malformed success payloads", async () => {
    const catalog = { jsonrpc: "2.0", id: 1, result: { tools: [
      { name: "brainbase_resolve_turn" }, { name: "brainbase_admin_write" },
    ] } };
    for (const [upstream, expectedStatus] of [
      [new Response(`event: message\ndata: ${JSON.stringify(catalog)}\n\n`, { headers: { "content-type": "text/event-stream" } }), 200],
      [Response.json({ jsonrpc: "2.0", id: 1, result: {} }), 502],
    ] as const) {
      const response = await handleBrainbaseMcpProxyRequest(
        new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
        }) }),
        { BRAINBASE_MCP_BASE_URL: "https://bb.example.test" }, vi.fn(async () => upstream.clone()) as unknown as typeof fetch,
        { allowedTools: ["brainbase_resolve_turn"] },
      );
      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === 200) {
        expect(await response.text()).toContain('"tools":[{"name":"brainbase_resolve_turn"}]');
      } else {
        expect(await response.json()).toEqual({ error: { code: "BRAINBASE_MCP_TOOL_CATALOG_INVALID", retryable: true } });
      }
    }
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
