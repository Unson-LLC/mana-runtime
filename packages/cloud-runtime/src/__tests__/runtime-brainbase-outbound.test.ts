import { beforeEach, describe, expect, it, vi } from "vitest";

const boundaryMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("../multitenancy/durable-tenant-boundary.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/durable-tenant-boundary.js")>();
  return { ...actual, resolveDurableTenantBoundaryContext: boundaryMocks.resolve };
});

import { authorizeRuntimeBrainbaseOutbound } from "../runtime-brainbase-outbound.js";
import type { TenantBoundaryContextNamespace } from "../multitenancy/durable-tenant-boundary.js";

describe("authorizeRuntimeBrainbaseOutbound", () => {
  beforeEach(() => {
    boundaryMocks.resolve.mockReset();
    boundaryMocks.resolve.mockResolvedValue({ tenant_context: { operation_id: "op-brainbase" } });
  });

  it("validates the tenant boundary and injects only the Worker-side Brainbase credential", async () => {
    const providerFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer runtime-brainbase-token");
      expect(headers.get("x-mana-tenant-boundary-handle")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-brainbase-project-code")).toBe("mana");
      return Response.json({ jsonrpc: "2.0", result: {} });
    }) as unknown as typeof fetch;

    const response = await authorizeRuntimeBrainbaseOutbound(
      new Request("https://brainbase-mcp.internal/host/judgment/hook", {
        method: "POST",
        headers: {
          authorization: "Bearer hostile-input",
          cookie: "must-not-forward=1",
          "x-mana-tenant-boundary-handle": "boundary-handle",
        },
        body: "{}",
      }),
      {
        TENANT_RUNTIME_STATE: {} as TenantBoundaryContextNamespace,
        BRAINBASE_MCP_BASE_URL: "https://bb.unson.jp/runtime-mcp",
        BRAINBASE_MCP_TOKEN: "runtime-brainbase-token",
        BRAINBASE_JUDGMENT_PROJECT_CODE: "mana",
      },
      providerFetch,
    );

    expect(response.status).toBe(200);
    expect(boundaryMocks.resolve).toHaveBeenCalledTimes(1);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("never falls back to a global Hook token/project for Company Authority", async () => {
    boundaryMocks.resolve.mockResolvedValue({
      tenant_context: { operation_id: "op-a0" }, company_authority_envelope: { accepted: true },
    });
    const providerFetch = vi.fn();
    const response = await authorizeRuntimeBrainbaseOutbound(
      new Request("https://brainbase-mcp.internal/host/judgment/hook", { method: "POST", body: "{}" }),
      {
        TENANT_RUNTIME_STATE: {} as TenantBoundaryContextNamespace,
        BRAINBASE_MCP_BASE_URL: "https://bb.unson.jp/runtime-mcp",
        BRAINBASE_MCP_TOKEN: "global-token-must-not-be-used",
        BRAINBASE_JUDGMENT_PROJECT_CODE: "other-project",
      }, providerFetch,
    );
    expect(response.status).toBe(503);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("fails closed before using the platform credential when the tenant boundary is rejected", async () => {
    boundaryMocks.resolve.mockResolvedValue(new Response("rejected", { status: 403 }));
    const providerFetch = vi.fn();
    const response = await authorizeRuntimeBrainbaseOutbound(
      new Request("https://brainbase-mcp.internal/host/judgment/hook", { method: "POST", body: "{}" }),
      {
        TENANT_RUNTIME_STATE: {} as TenantBoundaryContextNamespace,
        BRAINBASE_MCP_BASE_URL: "https://bb.unson.jp/runtime-mcp",
        BRAINBASE_MCP_TOKEN: "runtime-brainbase-token",
      },
      providerFetch as typeof fetch,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "TENANT_BOUNDARY_REJECTED", retryable: true },
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("rejects generic model-origin MCP before resolving a tenant boundary", async () => {
    const providerFetch = vi.fn();
    const response = await authorizeRuntimeBrainbaseOutbound(
      new Request("https://brainbase-mcp.internal/mcp", { method: "POST", body: "{}" }),
      {
        TENANT_RUNTIME_STATE: {} as TenantBoundaryContextNamespace,
        BRAINBASE_MCP_BASE_URL: "https://bb.unson.jp/runtime-mcp",
        BRAINBASE_MCP_TOKEN: "runtime-brainbase-token",
      },
      providerFetch as typeof fetch,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "BRAINBASE_OPERATION_FORBIDDEN", retryable: false } });
    expect(boundaryMocks.resolve).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
