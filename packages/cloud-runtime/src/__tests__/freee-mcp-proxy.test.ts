import { describe, expect, it, vi } from "vitest";
import { handleFreeeMcpProxyRequest } from "../freee-mcp-proxy.js";

describe("freee MCP proxy", () => {
  it("forwards read-only tool calls without caller credentials", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      return Response.json({ jsonrpc: "2.0", result: { content: [] } });
    }) as unknown as typeof fetch;

    const response = await handleFreeeMcpProxyRequest(
      new Request("https://freee-mcp.internal/mcp", {
        method: "POST",
        headers: { authorization: "Bearer caller-secret", cookie: "sid=secret" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "freee_api_get", arguments: { path: "/api/1/deals" } },
        }),
      }),
      {},
      fetchImpl,
    );

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://mcp.freee.co.jp/mcp",
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
  });

  it.each(["freee_api_post", "freee_api_put", "freee_api_patch", "freee_api_delete", "freee_clear_auth"])(
    "rejects write-capable tool %s before upstream forwarding",
    async (tool) => {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const response = await handleFreeeMcpProxyRequest(
        new Request("https://freee-mcp.internal/mcp", {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: {} } }),
        }),
        {},
        fetchImpl,
      );
      expect(response.status).toBe(403);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("filters write-capable tools out of JSON tools/list discovery", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "freee_api_get", description: "read" },
          { name: "freee_api_post", description: "write" },
          { name: "freee_api_delete", description: "delete" },
          { name: "freee_current_user", description: "whoami" },
        ],
      },
    })) as unknown as typeof fetch;

    const response = await handleFreeeMcpProxyRequest(
      new Request("https://freee-mcp.internal/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      {},
      fetchImpl,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "freee_api_get", description: "read" },
          { name: "freee_current_user", description: "whoami" },
        ],
      },
    });
  });

  it("filters write-capable tools out of SSE tools/list discovery", async () => {
    const upstream = {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "freee_api_get" }, { name: "freee_api_patch" }] },
    };
    const fetchImpl = vi.fn(async () => new Response(`event: message\ndata: ${JSON.stringify(upstream)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;

    const response = await handleFreeeMcpProxyRequest(
      new Request("https://freee-mcp.internal/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      {},
      fetchImpl,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "freee_api_get" }] },
    }));
    expect(await (async () => "")()).not.toContain("freee_api_patch");
  });

  it("allows MCP lifecycle traffic and rejects redirects", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 307, headers: { location: "https://evil.example" } })) as unknown as typeof fetch;
    const response = await handleFreeeMcpProxyRequest(
      new Request("https://freee-mcp.internal/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
      {},
      fetchImpl,
    );
    expect(response.status).toBe(502);
  });

  it("fails closed for invalid configuration and non-MCP paths", async () => {
    expect((await handleFreeeMcpProxyRequest(
      new Request("https://freee-mcp.internal/mcp", { method: "POST", body: "{}" }),
      { FREEE_MCP_BASE_URL: "http://mcp.freee.co.jp" },
    )).status).toBe(503);
    expect((await handleFreeeMcpProxyRequest(new Request("https://freee-mcp.internal/health"), {})).status).toBe(404);
  });
});
