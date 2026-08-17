import { describe, expect, it, vi } from "vitest";

import {
  authorizeDurableTenantBoundaryRequest,
  createDurableTenantBoundaryRegistry,
  TenantBoundaryContextHandler,
  TENANT_BOUNDARY_HANDLE_HEADER,
} from "../multitenancy/durable-tenant-boundary.js";
import { TenantBoundaryError } from "../multitenancy/errors.js";
import type {
  BoundaryName,
  ExpectedTenantScope,
  TenantContextEnvelope,
} from "../multitenancy/contracts.js";

const NOW = "2026-08-17T04:00:00.000Z";
const CONTEXT = {
  expires_at: "2026-08-17T04:01:00.000Z",
  tenant: { tenant_id: "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
} as TenantContextEnvelope;
const SCOPE = {
  audience: "mana-runtime",
  workspace_id: "T_WORKSPACE_A",
  app_id: "A_APP_A",
  channel_id: "C_CHANNEL_A",
  thread_ts: "1710000000.000001",
  actor_principal_id: "person_a",
  project_id: "project_a",
  capability_id: "runtime.execute",
  deployment_id: "deployment_a",
} satisfies ExpectedTenantScope;

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> { return Promise.resolve(this.values.get(key) as T | undefined); }
  put(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); return Promise.resolve(); }
  delete(key: string): Promise<boolean> { return Promise.resolve(this.values.delete(key)); }
}

class IsolatedBoundaryNamespace {
  readonly handlers = new Map<string, TenantBoundaryContextHandler>();
  readonly validate = vi.fn(async (_input: {
    boundary: BoundaryName;
    tenant_context: TenantContextEnvelope;
    expected_scope: ExpectedTenantScope;
    now: string;
  }) => undefined);

  idFromName(name: string): string { return name; }
  get(id: unknown): { fetch(request: Request): Promise<Response> } {
    const key = String(id);
    return { fetch: (request) => {
      let handler = this.handlers.get(key);
      if (!handler) {
        handler = new TenantBoundaryContextHandler(new MemoryStorage(), this.validate);
        this.handlers.set(key, handler);
      }
      return handler.fetch(request);
    } };
  }
}

describe("durable tenant boundary integration", () => {
  it("carries only an opaque operation handle into the Container and revalidates MCP plus Brainbase boundaries", async () => {
    const namespace = new IsolatedBoundaryNamespace();
    const registry = createDurableTenantBoundaryRegistry(namespace);
    const handle = await registry.register({ tenant_context: CONTEXT, expected_scope: SCOPE, now: NOW });

    expect(handle).not.toContain(CONTEXT.tenant.tenant_id);
    const request = new Request("https://task-search.internal/api/companion/tasks/search?query=mana", {
      headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: handle },
    });
    await expect(authorizeDurableTenantBoundaryRequest(namespace, request, "mcp_gateway", NOW))
      .resolves.toBeUndefined();
    await expect(authorizeDurableTenantBoundaryRequest(namespace, request, "brainbase_proxy", NOW))
      .resolves.toBeUndefined();
    expect(namespace.validate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      boundary: "mcp_gateway", tenant_context: CONTEXT, expected_scope: SCOPE,
    }));
    expect(namespace.validate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      boundary: "brainbase_proxy", tenant_context: CONTEXT, expected_scope: SCOPE,
    }));

    await registry.dispose(handle);
    const disposed = await authorizeDurableTenantBoundaryRequest(namespace, request, "mcp_gateway", NOW);
    expect(disposed).toMatchObject({ status: 503 });
  });

  it("fails closed without a handle and preserves revision failure", async () => {
    const namespace = new IsolatedBoundaryNamespace();
    const missing = await authorizeDurableTenantBoundaryRequest(
      namespace,
      new Request("https://task-search.internal/api/companion/tasks/search?query=mana"),
      "mcp_gateway",
      NOW,
    );
    expect(missing).toMatchObject({ status: 503 });

    namespace.validate.mockRejectedValueOnce(new TenantBoundaryError(
      "mcp_gateway",
      "WORKSPACE_CONNECTION_STALE_REVISION",
    ));
    const registry = createDurableTenantBoundaryRegistry(namespace);
    const handle = await registry.register({ tenant_context: CONTEXT, expected_scope: SCOPE, now: NOW });
    const rejected = await authorizeDurableTenantBoundaryRequest(namespace, new Request(
      "https://task-search.internal/api/companion/tasks/search?query=mana",
      { headers: { [TENANT_BOUNDARY_HANDLE_HEADER]: handle } },
    ), "mcp_gateway", NOW);
    expect(rejected).toMatchObject({ status: 503 });
    await expect(rejected?.json()).resolves.toEqual({
      boundary: "mcp_gateway",
      error: "WORKSPACE_CONNECTION_STALE_REVISION",
    });
  });
});
