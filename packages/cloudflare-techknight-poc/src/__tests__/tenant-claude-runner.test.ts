import { afterEach, describe, expect, it, vi } from "vitest";

import { startTenantAnthropicProxy } from "../../container/tenant-claude-runner.mjs";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("tenant Claude provider control channel", () => {
  it("keeps the tenant handle out of provider auth while forwarding through the dedicated header", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
      expect(request.headers.get("x-mana-tenant-boundary-handle")).toBe("tb_opaque_operation_handle_1234567890");
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("x-api-key")).toBeNull();
      return Response.json({ id: "msg-a" });
    }) as typeof fetch;
    const proxy = await startTenantAnthropicProxy({
      tenantBoundaryHandle: "tb_opaque_operation_handle_1234567890",
      fetchImpl: upstream,
    });
    closers.push(proxy.close);

    const response = await fetch(`${proxy.baseUrl}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        authorization: "Bearer mana-runtime-trusted-forwarder",
        "x-api-key": "mana-runtime-trusted-forwarder",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "msg-a" });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each(["", "mana-tenant-boundary-v1:tb_opaque_operation_handle_1234567890", "contains space"])(
    "rejects a missing or provider-marker-shaped control handle: %s",
    async (tenantBoundaryHandle) => {
      await expect(startTenantAnthropicProxy({
        tenantBoundaryHandle,
        fetchImpl: vi.fn() as typeof fetch,
      })).rejects.toThrow("tenant_boundary_required");
    },
  );
});
