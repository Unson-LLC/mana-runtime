import { describe, expect, it, vi } from "vitest";
import { handleFreeeMcpProxyRequest } from "../freee-mcp-proxy.js";

const ENV = { FREEE_MCP_BASE_URL: "https://mcp.freee.co.jp" };

describe("freee MCP proxy", () => {
  it("forwards read-only tool calls with only allowlisted MCP headers", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-untrusted")).toBeNull();
      expect(headers.get("mcp-session-id")).toBe("session-a");
      expect(headers.get("mcp-protocol-version")).toBe("2025-06-18");
      return Response.json({ jsonrpc: "2.0", result: { content: [] } });
    }) as unknown as typeof fetch;

    const response = await handleFreeeMcpProxyRequest(
      new Request("https://freee-mcp.internal/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer caller-secret",
          cookie: "sid=secret",
          "x-untrusted": "nope",
          "mcp-session-id": "session-a",
          "mcp-protocol-version": "2025-06-18",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "freee_api_get", arguments: { path: "/api/1/deals" } },
        }),
      }),
      ENV,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://mcp.freee.co.jp/mcp",
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
  });

  it.each([
    "freee_api_post",
    "freee_api_put",
    "freee_api_patch",
    "freee_api_delete",
    "freee_clear_auth",
    "freee_set_current_company",
  ])("rejects non-read-only tool %s before upstream forwarding", async (tool) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const response = await handleFreeeMcpProxyRequest(
      new Request("https://freee-mcp.internal/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: {} } }),
      }),
      ENV,
      fetchImpl,
    );
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["resources/read", "resources/subscribe", "prompts/get", "completion/complete"])(
    "rejects non-allowlisted MCP method %s",
    async (method) => {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const response = await handleFreeeMcpProxyRequest(
        new Request("https://freee-mcp.internal/mcp", {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
        }),
        ENV,
        fetchImpl,
      );
      expect(response.status).toBe(403);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed JSON locally", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const response = await handleFreeeMcpProxyRequest(
      new Request("https://freee-mcp.internal/mcp", { method: "POST", body: "{" }),
      ENV,
      fetchImpl,
    );
    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("filters non-read-only tools out of JSON tools/list discovery", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "freee_api_get", description: "read" },
          { name: "freee_api_post", description: "write" },
          { name: "freee_set_current_company", description: "changes target company" },
          { name: "freee_current_user", description: "whoami" },
        ],
      },
    })) as unknown as typeof fetch;

    const response = await handleFreeeMcpProxyRequest(
      new Request("https://freee-mcp.internal/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      ENV,
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

  it("filters non-read-only tools out of CRLF SSE tools/list discovery", async () => {
    const upstream = {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "freee_api_get" }, { name: "freee_api_patch" }] },
    };
    const fetchImpl = vi.fn(async () => new Response(`event: message\r\ndata: ${JSON.stringify(upstream)}\r\n\r\n`, {
      headers: { "content-type": "text/event-stream", "set-cookie": "secret=1" },
    })) as unknown as typeof fetch;

    const response = await handleFreeeMcpProxyRequest(
      new Request("https://freee-mcp.internal/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      ENV,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const text = await response.text();
    expect(text).toContain("\r\n");
    expect(text).toContain(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "freee_api_get" }] },
    }));
    expect(text).not.toContain("freee_api_patch");
  });

  it("allows known MCP lifecycle traffic and rejects redirects", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 307, headers: { location: "https://evil.example" } })) as unknown as typeof fetch;
    const response = await handleFreeeMcpProxyRequest(
      new Request("https://freee-mcp.internal/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
      ENV,
      fetchImpl,
    );
    expect(response.status).toBe(502);
  });

  it("fails closed when the upstream URL is absent or invalid", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect((await handleFreeeMcpProxyRequest(
      new Request("https://freee-mcp.internal/mcp", { method: "POST", body: "{}" }),
      {},
      fetchImpl,
    )).status).toBe(503);
    expect((await handleFreeeMcpProxyRequest(
      new Request("https://freee-mcp.internal/mcp", { method: "POST", body: "{}" }),
      { FREEE_MCP_BASE_URL: "http://mcp.freee.co.jp" },
      fetchImpl,
    )).status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-MCP paths", async () => {
    const response = await handleFreeeMcpProxyRequest(
      new Request("https://freee-mcp.internal/health"),
      ENV,
      vi.fn() as unknown as typeof fetch,
    );
    expect(response.status).toBe(404);
  });
});
