import { beforeEach, describe, expect, it, vi } from "vitest";

const boundaryMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("../multitenancy/durable-tenant-boundary.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../multitenancy/durable-tenant-boundary.js")>();
  return { ...actual, resolveDurableTenantBoundaryContext: boundaryMocks.resolve };
});

import {
  authorizeRuntimeAnthropicOutbound,
  type RuntimeAnthropicOutboundEnv,
} from "../runtime-anthropic-outbound.js";

describe("authorizeRuntimeAnthropicOutbound", () => {
  beforeEach(() => {
    boundaryMocks.resolve.mockReset();
    boundaryMocks.resolve.mockResolvedValue({ tenant_context: { operation_id: "op-a" } });
  });

  it("keeps the tenant boundary but uses the runtime Claude credential instead of the Slack lease", async () => {
    const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
      const request = new Request(input);
      expect(request.headers.get("authorization")).toBe("Bearer runtime-oauth");
      expect(request.headers.get("x-api-key")).toBeNull();
      expect(request.headers.get("x-mana-tenant-boundary-handle")).toBeNull();
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("x-internal-control")).toBeNull();
      return Response.json({ ok: true });
    });
    const response = await authorizeRuntimeAnthropicOutbound(
      new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer hostile-input",
          "x-api-key": "hostile-input",
          "x-mana-tenant-boundary-handle": "boundary-handle",
          cookie: "must-not-forward=1",
          "x-internal-control": "must-not-forward",
        },
        body: "{}",
      }),
      {
        TENANT_RUNTIME_STATE: {} as DurableObjectNamespace,
        CLAUDE_CODE_OAUTH_TOKEN: "runtime-oauth",
      } as RuntimeAnthropicOutboundEnv,
      providerFetch as typeof fetch,
    );

    expect(response.status).toBe(200);
    expect(boundaryMocks.resolve).toHaveBeenCalledTimes(1);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the tenant boundary is rejected", async () => {
    boundaryMocks.resolve.mockResolvedValue(new Response("rejected", { status: 403 }));
    const providerFetch = vi.fn();
    const response = await authorizeRuntimeAnthropicOutbound(
      new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
      {
        TENANT_RUNTIME_STATE: {} as DurableObjectNamespace,
        CLAUDE_CODE_OAUTH_TOKEN: "runtime-oauth",
      } as RuntimeAnthropicOutboundEnv,
      providerFetch as typeof fetch,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "TENANT_BOUNDARY_REJECTED", retryable: true } });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("fails closed when no runtime Claude credential is configured", async () => {
    const providerFetch = vi.fn();
    const response = await authorizeRuntimeAnthropicOutbound(
      new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
      { TENANT_RUNTIME_STATE: {} as DurableObjectNamespace } as RuntimeAnthropicOutboundEnv,
      providerFetch as typeof fetch,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "ANTHROPIC_CREDENTIAL_UNAVAILABLE", retryable: true } });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "https://api.anthropic.com/v1/messages"],
    ["POST", "https://api.anthropic.com/v1/models"],
    ["POST", "https://example.test/v1/messages"],
  ])("rejects an unapproved Anthropic operation: %s %s", async (method, url) => {
    const providerFetch = vi.fn();
    const response = await authorizeRuntimeAnthropicOutbound(
      new Request(url, { method }),
      {
        TENANT_RUNTIME_STATE: {} as DurableObjectNamespace,
        CLAUDE_CODE_OAUTH_TOKEN: "runtime-oauth",
      } as RuntimeAnthropicOutboundEnv,
      providerFetch as typeof fetch,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "ANTHROPIC_OPERATION_FORBIDDEN", retryable: false } });
    expect(boundaryMocks.resolve).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("turns provider failures into a stable upstream error", async () => {
    const response = await authorizeRuntimeAnthropicOutbound(
      new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
      {
        TENANT_RUNTIME_STATE: {} as DurableObjectNamespace,
        CLAUDE_CODE_OAUTH_TOKEN: "runtime-oauth",
      } as RuntimeAnthropicOutboundEnv,
      vi.fn(async () => { throw new Error("socket detail must not escape"); }) as typeof fetch,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: "ANTHROPIC_UPSTREAM_UNAVAILABLE", retryable: true } });
  });
});
