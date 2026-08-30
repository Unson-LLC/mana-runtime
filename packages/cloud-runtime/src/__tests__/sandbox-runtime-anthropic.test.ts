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
      return Response.json({ ok: true });
    });
    const response = await authorizeRuntimeAnthropicOutbound(
      new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer hostile-input",
          "x-api-key": "hostile-input",
          "x-mana-tenant-boundary-handle": "boundary-handle",
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
      new Request("https://api.anthropic.com/v1/messages"),
      {
        TENANT_RUNTIME_STATE: {} as DurableObjectNamespace,
        CLAUDE_CODE_OAUTH_TOKEN: "runtime-oauth",
      } as RuntimeAnthropicOutboundEnv,
      providerFetch as typeof fetch,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("tenant_boundary_rejected");
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("fails closed when no runtime Claude credential is configured", async () => {
    const providerFetch = vi.fn();
    const response = await authorizeRuntimeAnthropicOutbound(
      new Request("https://api.anthropic.com/v1/messages"),
      { TENANT_RUNTIME_STATE: {} as DurableObjectNamespace } as RuntimeAnthropicOutboundEnv,
      providerFetch as typeof fetch,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("anthropic_credential_unavailable");
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
